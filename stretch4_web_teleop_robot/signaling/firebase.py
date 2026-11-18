"""Firebase Realtime Database signaling for the robot (the cloud door).

The robot's half of the protocol in src/shared/signaling/FirebaseSignaling.ts.
There is no maintained Python client SDK for end-user Firebase auth, so this speaks the
documented REST APIs directly:

* Identity Toolkit ``accounts:signInWithPassword`` / Secure Token refresh for
  the robot account's ID token;
* Realtime Database REST for reads and writes, and its server-sent-events
  stream for the ``rooms/<uid>/operator`` listener (``onValue`` in the SDK).

Writes go out one at a time, in order, like the SDK's write queue.

One difference from the SDK: REST has no ``onDisconnect``. The robot clears its
seat on a clean shutdown (``leave``) and re-claims it on every start; a crashed
robot leaves ``rooms/<uid>/robot/active`` true until it restarts.
"""

import asyncio
import copy
import json
import logging
import os
import time
from dataclasses import dataclass

import aiohttp

from .base import Callbacks, Signaling

log = logging.getLogger(__name__)

CONFIGURE_TIMEOUT_S = 20.0
TOKEN_REFRESH_MARGIN_S = 300.0


@dataclass
class FirebaseConfig:
    api_key: str
    database_url: str
    username: str
    password: str
    fleet_id: str

    @classmethod
    def from_env(cls) -> "FirebaseConfig":
        missing = [
            k
            for k in (
                "PUBLIC_FIREBASE_API_KEY",
                "PUBLIC_FIREBASE_DATABASE_URL",
                "ROBOT_USERNAME",
                "ROBOT_PASSWORD",
            )
            if not os.environ.get(k)
        ]
        if missing:
            raise RuntimeError(f"Missing robot Firebase settings: {', '.join(missing)}")
        return cls(
            api_key=os.environ["PUBLIC_FIREBASE_API_KEY"],
            database_url=os.environ["PUBLIC_FIREBASE_DATABASE_URL"].rstrip("/"),
            username=os.environ["ROBOT_USERNAME"],
            password=os.environ["ROBOT_PASSWORD"],
            fleet_id=os.environ.get("HELLO_FLEET_ID", "unknown"),
        )


def _is_equal(a, b) -> bool:
    return a == b


def _apply_at_path(root, path: str, data):
    """Return ``root`` with ``data`` written at ``path`` (None deletes)."""
    parts = [p for p in path.split("/") if p]
    if not parts:
        return copy.deepcopy(data)
    root = copy.deepcopy(root) if isinstance(root, dict) else {}
    node = root
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    if data is None:
        node.pop(parts[-1], None)
    else:
        node[parts[-1]] = copy.deepcopy(data)
    return root or None


class FirebaseSignaling(Signaling):
    def __init__(self, callbacks: Callbacks, config: FirebaseConfig):
        super().__init__(callbacks)
        self.config = config
        self.session: aiohttp.ClientSession | None = None
        self.uid: str | None = None
        self.id_token: str | None = None
        self.refresh_token: str | None = None
        self.token_expires_at = 0.0
        self.robot_name: str | None = None
        self.room_uid: str | None = None
        self.is_joined = False
        self.prev_signal = None
        self.snapshot = None
        self._writes: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []

    # ---------------------------------------------------------------- auth

    async def _sign_in(self) -> None:
        url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={self.config.api_key}"
        body = {
            "email": self.config.username,
            "password": self.config.password,
            "returnSecureToken": True,
        }
        async with self.session.post(url, json=body) as response:
            data = await response.json()
            if response.status != 200:
                raise RuntimeError(
                    f"Firebase sign-in failed: {data.get('error', {}).get('message', response.status)}"
                )
        self.uid = data["localId"]
        self._set_token(data["idToken"], data["refreshToken"], data["expiresIn"])

    async def _refresh(self) -> None:
        url = f"https://securetoken.googleapis.com/v1/token?key={self.config.api_key}"
        form = {"grant_type": "refresh_token", "refresh_token": self.refresh_token}
        async with self.session.post(url, data=form) as response:
            data = await response.json()
            if response.status != 200:
                raise RuntimeError(f"Firebase token refresh failed: {data}")
        self._set_token(data["id_token"], data["refresh_token"], data["expires_in"])

    def _set_token(self, id_token: str, refresh_token: str, expires_in) -> None:
        self.id_token = id_token
        self.refresh_token = refresh_token
        self.token_expires_at = time.monotonic() + float(expires_in)

    async def _token(self) -> str:
        if time.monotonic() > self.token_expires_at - TOKEN_REFRESH_MARGIN_S:
            await self._refresh()
        return self.id_token

    # -------------------------------------------------------- database REST

    def _url(self, path: str) -> str:
        return f"{self.config.database_url}/{path.strip('/')}.json"

    async def _request(self, method: str, path: str, body=None):
        params = {"auth": await self._token()}
        async with self.session.request(
            method, self._url(path), params=params, json=body
        ) as response:
            text = await response.text()
            if response.status != 200:
                raise RuntimeError(
                    f"Firebase {method} {path} failed ({response.status}): {text[:200]}"
                )
            return json.loads(text) if text else None

    async def get(self, path: str):
        return await self._request("GET", path)

    def _write(self, method: str, path: str, body) -> asyncio.Future:
        """Queue a write; writes are applied strictly in order."""
        future = asyncio.get_running_loop().create_future()
        # Fire-and-forget callers never await; the worker already logged it.
        future.add_done_callback(lambda f: f.cancelled() or f.exception())
        self._writes.put_nowait((method, path, body, future))
        return future

    async def _write_worker(self) -> None:
        while True:
            method, path, body, future = await self._writes.get()
            try:
                result = await self._request(method, path, body)
                if not future.done():
                    future.set_result(result)
            except Exception as error:  # noqa: BLE001
                log.error("Firebase write failed: %s", error)
                if not future.done():
                    future.set_exception(error)

    # ------------------------------------------------------------- listener

    async def _listen(self, path: str) -> None:
        """Keep a server-sent-events stream on ``path`` open, like onValue."""
        while True:
            try:
                params = {"auth": await self._token()}
                timeout = aiohttp.ClientTimeout(total=None, sock_read=90)
                async with self.session.get(
                    self._url(path),
                    params=params,
                    headers={"Accept": "text/event-stream"},
                    timeout=timeout,
                ) as response:
                    if response.status != 200:
                        raise RuntimeError(f"stream {path} failed ({response.status})")
                    event = None
                    async for raw in response.content:
                        line = raw.decode("utf-8").rstrip("\r\n")
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            if self._on_stream_event(event, line[5:].strip()):
                                break  # token expiry: reconnect with a fresh one
                        if (
                            time.monotonic()
                            > self.token_expires_at - TOKEN_REFRESH_MARGIN_S
                        ):
                            break
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                log.warning("Firebase stream on %s dropped: %s", path, error)
                await asyncio.sleep(2.0)

    def _on_stream_event(self, event: str | None, data: str) -> bool:
        if event in ("put", "patch"):
            payload = json.loads(data)
            if event == "put":
                self.snapshot = _apply_at_path(
                    self.snapshot, payload["path"], payload["data"]
                )
            else:
                for key, value in (payload["data"] or {}).items():
                    self.snapshot = _apply_at_path(
                        self.snapshot, f"{payload['path'].rstrip('/')}/{key}", value
                    )
            self._apply_room_signal(copy.deepcopy(self.snapshot))
        elif event == "auth_revoked":
            return True
        elif event == "cancel":
            log.error("Firebase cancelled the operator listener: %s", data)
        return False

    def _apply_room_signal(self, curr) -> None:
        if not self.is_joined or not curr:
            return
        local_operator_lease = curr.get("transport") == "local"
        prev = self.prev_signal or {}
        changes = {
            key: value
            for key, value in curr.items()
            if self.prev_signal is None
            or key not in prev
            or not _is_equal(value, prev[key])
        }
        self.prev_signal = curr

        if local_operator_lease and ("active" in changes or "transport" in changes):
            self.callbacks.on_goodbye()
            return

        if not local_operator_lease and (
            "candidate" in changes
            or "sessionDescription" in changes
            or "cameraInfo" in changes
        ):
            signal = {k: v for k, v in changes.items() if k != "active"}
            self.callbacks.on_signal(signal)

        if "active" in changes and not changes["active"]:
            log.info("bye")
            self._write("PATCH", f"robots/{self.robot_name}", {"status": "online"})
            self.callbacks.on_goodbye()
            return

        if not local_operator_lease and "active" in changes and changes["active"]:
            log.info("Operator has joined the room. My role: robot.")
            self._write("PATCH", f"robots/{self.robot_name}", {"status": "occupied"})
            self.callbacks.on_robot_connection_start()

    # ------------------------------------------------------------ interface

    async def configure(self, room_name: str) -> None:
        await asyncio.wait_for(self._configure(), CONFIGURE_TIMEOUT_S)

    async def _configure(self) -> None:
        if self.session is None:
            self.session = aiohttp.ClientSession()
        await self._sign_in()
        assignment = await self.get(f"assignments/{self.uid}")
        if (
            not isinstance(assignment, dict)
            or assignment.get("role") != "robot"
            or not isinstance(assignment.get("name"), str)
            or assignment["name"] != self.config.fleet_id
        ):
            raise RuntimeError("Robot account is not provisioned for this fleet")
        self.robot_name = assignment["name"]
        self.room_uid = self.uid
        log.info("FirebaseSignaling: verified robot %s", self.robot_name)
        loop = asyncio.get_running_loop()
        self._tasks.append(loop.create_task(self._write_worker()))
        self._tasks.append(
            loop.create_task(self._listen(f"rooms/{self.room_uid}/operator"))
        )

    async def join_as_robot(self) -> bool:
        try:
            # Always reclaim: a seat left active by a crash is ours anyway.
            await self._write(
                "PUT", f"rooms/{self.room_uid}/robot", {"active": True, "uid": self.uid}
            )
            self.is_joined = True
            self._write("PATCH", f"robots/{self.robot_name}", {"status": "online"})
            return True
        except Exception as error:  # noqa: BLE001
            log.error("FirebaseSignaling: robot seat claim failed: %s", error)
            return False

    def leave(self) -> None:
        if not self.room_uid or not self.is_joined:
            return
        self.is_joined = False
        log.info("Leaving. My role: robot.")
        self._write("PUT", f"rooms/{self.room_uid}/robot", {"active": False})
        self._write("PATCH", f"robots/{self.robot_name}", {"status": "offline"})

    def send(self, signal: dict) -> None:
        if not self.is_joined:
            return
        sanitized = {}
        if signal.get("sessionDescription"):
            sd = signal["sessionDescription"]
            sanitized["sessionDescription"] = {"type": sd["type"], "sdp": sd["sdp"]}
        if signal.get("candidate"):
            sanitized["candidate"] = signal["candidate"]
        if signal.get("cameraInfo"):
            sanitized["cameraInfo"] = signal["cameraInfo"]
        if sanitized:
            self._write("PATCH", f"rooms/{self.room_uid}/robot", sanitized)

    async def close(self) -> None:
        # Let queued writes (the leave() release) land before closing.
        deadline = time.monotonic() + 3.0
        while not self._writes.empty() and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.2)
        for task in self._tasks:
            task.cancel()
        if self.session is not None:
            await self.session.close()
