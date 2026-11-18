"""socket.io signaling through the robot's own server.js (the LAN door).

The robot's half of the protocol whose operator half is
src/shared/signaling/LocalSignaling.ts; server.js relays between them.
"""

import asyncio
import logging

import socketio

from .base import Callbacks, Signaling

log = logging.getLogger(__name__)

RECLAIM_LIMIT = 5
RECLAIM_DELAY_S = 0.4


class LocalSignaling(Signaling):
    def __init__(self, callbacks: Callbacks, server_url: str = "https://localhost"):
        super().__init__(callbacks)
        self.server_url = server_url
        self.role: str | None = None
        self._reclaim_task: asyncio.Task | None = None
        # server.js serves a self-signed certificate on loopback; the robot
        # page skipped verification the same way (ignoreHTTPSErrors).
        # handle_sigint=False: engineio's own SIGINT handler cancels every task
        # on the loop, which would skip our orderly stop-the-robot shutdown.
        self.sio = socketio.AsyncClient(
            ssl_verify=False, reconnection=True, logger=False, handle_sigint=False
        )
        self.sio.on("connect", self._on_connect)
        self.sio.on(
            "disconnect", lambda *args: log.warning("Local socket disconnected")
        )
        self.sio.on("signalling", self._on_signalling)
        self.sio.on("bye", lambda *args: self.callbacks.on_goodbye())
        self.sio.on("joined", self._on_joined)
        self._connected = asyncio.Event()

    async def _on_connect(self):
        log.info("Connected to local socket")
        self._connected.set()
        if self.role == "robot":
            self._start_reclaim()

    def _on_signalling(self, signal):
        self.callbacks.on_signal(signal)

    def _on_joined(self, *args):
        log.info("Operator has joined the room. My role: %s.", self.role)
        self.callbacks.on_robot_connection_start()

    def _start_reclaim(self):
        if self._reclaim_task and not self._reclaim_task.done():
            self._reclaim_task.cancel()
        self._reclaim_task = asyncio.get_running_loop().create_task(self._reclaim())

    async def _reclaim(self):
        # After a reconnect the server has forgotten our seat; take it back.
        for attempt in range(RECLAIM_LIMIT + 1):
            if await self.join_as_robot():
                return
            await asyncio.sleep(RECLAIM_DELAY_S)
        log.error("Local signaling room reclaim stopped")

    async def configure(self, room_name: str) -> None:
        if not self.sio.connected:
            # Keep trying: server.js is started alongside us and may not be up yet.
            while True:
                try:
                    await self.sio.connect(
                        self.server_url, transports=["websocket"], wait_timeout=10
                    )
                    break
                except socketio.exceptions.ConnectionError as error:
                    log.info("Local signaling server not reachable yet: %s", error)
                    await asyncio.sleep(1.0)

    async def join_as_robot(self) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), 10)
            response = await self.sio.call("join_as_robot", timeout=10)
        except (
            asyncio.TimeoutError,
            socketio.exceptions.TimeoutError,
            socketio.exceptions.BadNamespaceError,
        ) as error:
            log.warning("join_as_robot failed: %s", error)
            return False
        success = bool(response and response.get("success"))
        if success:
            self.role = "robot"
        return success

    def leave(self) -> None:
        if self._reclaim_task and not self._reclaim_task.done():
            self._reclaim_task.cancel()
        log.info("Leaving. My role: %s.", self.role)
        if self.sio.connected:
            asyncio.get_running_loop().create_task(self._emit("bye", self.role))

    def send(self, signal: dict) -> None:
        if not self.sio.connected:
            log.warning("Dropping signal: local socket is not connected")
            return
        asyncio.get_running_loop().create_task(self._emit("signalling", signal))

    async def _emit(self, event: str, data) -> None:
        # The socket can drop between the connected check and the send (for
        # example when server.js stops first); that is not worth a traceback.
        try:
            await self.sio.emit(event, data)
        except socketio.exceptions.SocketIOError as error:
            log.warning("Could not send %s: %s", event, error)

    async def close(self) -> None:
        if self.sio.connected:
            await self.sio.disconnect()
