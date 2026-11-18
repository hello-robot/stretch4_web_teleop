"""Robot end of the operator <-> robot WebRTC connection.

Built on aiortc. The operator's end is src/shared/webrtcconnections.tsx. The
wire protocol:

* signaling messages are ``{sessionDescription, cameraInfo}`` and
  ``{candidate}``; ``cameraInfo`` maps each media stream id to
  ``overhead`` / ``gripper`` / ``audio`` and may carry the operator's
  ``hr-renegotiate`` nonce, which the robot echoes on its next offer;
* the robot is the impolite peer and makes the offer;
* one reliable, ordered data channel named ``messages`` carries JSON.

aiortc gathers ICE candidates before ``setLocalDescription`` returns, so the
robot's candidates travel inside its SDP rather than being trickled. The
operator's trickled candidates are applied as they come.
"""

import asyncio
import json
import logging
import os
import uuid
from typing import Any, Callable

import aioice.ice
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.sdp import candidate_from_sdp

log = logging.getLogger(__name__)

RENEGOTIATE_CAMERA_INFO_KEY = "hr-renegotiate"
ICE_SERVERS = [RTCIceServer(urls="stun:stun1.l.google.com:19302")]
_MISSING = object()

# aiortc cannot trickle: the offer waits until every candidate is gathered,
# and aioice waits up to 5 s for a STUN answer on *each* IPv4 interface. VPN,
# docker and secondary addresses never answer, so every connection paid the
# full 5 s. A reachable STUN server answers in tens of milliseconds (a few
# hundred on a poor uplink); cap the wait so an unanswered interface costs at
# most this much. Host candidates, which the LAN door relies on, are unaffected.
STUN_TIMEOUT_S = float(os.environ.get("WEB_TELEOP_STUN_TIMEOUT", "0.5"))


def _cap_stun_wait() -> None:
    original = aioice.ice.Connection.get_component_candidates
    if getattr(original, "_web_teleop_capped", False):
        return

    async def get_component_candidates(self, component, addresses, timeout=5):
        return await original(
            self, component, addresses, timeout=min(timeout, STUN_TIMEOUT_S)
        )

    setattr(get_component_candidates, "_web_teleop_capped", True)
    setattr(aioice.ice.Connection, "get_component_candidates", get_component_candidates)


_cap_stun_wait()


def _jsonable(value):
    """Replace non-finite floats with None, as JSON.stringify does."""
    if isinstance(value, float):
        return (
            value
            if value == value and value not in (float("inf"), float("-inf"))
            else None
        )
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def encode_message(obj) -> str:
    try:
        return json.dumps(obj, separators=(",", ":"), allow_nan=False)
    except ValueError:
        return json.dumps(_jsonable(obj), separators=(",", ":"))


class RobotConnection:
    """Owns the current RTCPeerConnection, its data channel, and signaling."""

    def __init__(
        self,
        create_signaler: Callable,
        on_robot_connection_start: Callable[[], None],
        on_message: Callable[[object], None],
        on_message_channel_open: Callable[[], None] | None = None,
        ice_servers=None,
    ):
        self.loop = asyncio.get_running_loop()
        self.on_robot_connection_start = on_robot_connection_start
        self.on_message = on_message
        self.on_message_channel_open = on_message_channel_open
        self.ice_servers = ICE_SERVERS if ice_servers is None else ice_servers
        self.camera_info: dict[str, str] = {}
        self.robot_renegotiation_nonce: str | None = None
        self.pc: RTCPeerConnection | None = None
        self.channel: Any = None
        self.making_offer = False
        self.pending_candidates: list = []
        self._session_tracks: list = []
        self._tasks: set[asyncio.Task] = set()
        self._signals: asyncio.Queue = asyncio.Queue()
        self._create_peer()
        self._spawn(self._signal_worker())
        self.signaler = create_signaler(
            on_signal=self._signals.put_nowait,
            on_goodbye=self.stop,
            on_robot_connection_start=self.start_robot_session,
        )

    # ------------------------------------------------------------ plumbing

    def _spawn(self, coro) -> asyncio.Task:
        task = self.loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("WebRTC task failed", exc_info=task.exception())

    def _create_peer(self) -> None:
        self.making_offer = False
        self.pending_candidates = []
        pc = RTCPeerConnection(RTCConfiguration(iceServers=self.ice_servers))
        self.pc = pc

        @pc.on("datachannel")
        def on_datachannel(channel):
            if pc is not self.pc:
                return
            if channel.label == "messages":
                self._set_message_channel(channel)
            else:
                log.error("Unknown channel opened: %s", channel.label)

        @pc.on("connectionstatechange")
        def on_state():
            if pc is not self.pc:
                return
            log.info("Peer connection %s", pc.connectionState)
            if pc.connectionState == "failed":
                self.start_robot_session()

        log.info("Created RTCPeerConnection")

    def _set_message_channel(self, channel) -> None:
        self.channel = channel

        @channel.on("message")
        def on_message(data):
            if channel is not self.channel:
                return
            if isinstance(data, bytes):
                data = data.decode("utf-8", "replace")
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                log.error("Malformed data channel message: %.200s", data)
                return
            try:
                self.on_message(obj)
            except (
                Exception
            ):  # noqa: BLE001 - one bad command must not kill the channel
                log.exception("Error handling message %.200s", data)

        def on_state_change():
            if channel is not self.channel:
                return
            log.info("Data channel state is: %s", channel.readyState)
            if channel.readyState == "open" and self.on_message_channel_open:
                self.on_message_channel_open()

        channel.on("open", on_state_change)
        channel.on("close", on_state_change)

    # ------------------------------------------------------------ sessions

    def start_robot_session(self) -> None:
        """Begin a session on a clean peer, then offer to the operator."""
        pc = self.pc
        if (
            pc is None
            or pc.connectionState != "new"
            or pc.getSenders()
            or self.channel is not None
        ):
            self.stop()
        self.camera_info = {}
        self.on_robot_connection_start()
        self._spawn(self._negotiate(self.pc))

    async def _negotiate(self, pc: RTCPeerConnection) -> None:
        if pc is not self.pc:
            return
        try:
            self.making_offer = True
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            if pc is not self.pc or pc.localDescription is None:
                return
            camera_info = dict(self.camera_info)
            if self.robot_renegotiation_nonce:
                camera_info[
                    RENEGOTIATE_CAMERA_INFO_KEY
                ] = self.robot_renegotiation_nonce
            self.signaler.send(
                {
                    "sessionDescription": {
                        "type": pc.localDescription.type,
                        "sdp": pc.localDescription.sdp,
                    },
                    "cameraInfo": camera_info,
                }
            )
            log.info("Sent offer")
        except Exception:  # noqa: BLE001
            if pc is self.pc:
                log.exception("Failed to create offer")
        finally:
            if pc is self.pc:
                self.making_offer = False

    def add_track(self, track, stream_name: str) -> None:
        stream_id = str(uuid.uuid4())
        sender = self.pc.addTrack(track)
        # The operator labels incoming streams by their msid stream id, which
        # aiortc otherwise shares across every track on the connection.
        sender._stream_id = stream_id
        self.camera_info[stream_id] = stream_name
        self._session_tracks.append(track)
        log.info("Added %s track", stream_name)

    def remove_tracks(self) -> None:
        for track in self._session_tracks:
            track.stop()
        self._session_tracks = []

    def open_data_channels(self) -> None:
        channel = self.pc.createDataChannel("messages")
        self._set_message_channel(channel)
        log.info("Opened data channel")

    def stop(self) -> None:
        """Tear down the current session and start a fresh, idle peer."""
        log.info("Session terminated.")
        self.remove_tracks()
        old = self.pc
        self.channel = None
        self._create_peer()
        if old is not None:
            self._spawn(old.close())

    def hangup(self) -> None:
        log.warning("Hanging up")
        self.signaler.leave()
        if self.pc is None or self.pc.connectionState == "new":
            return
        self.stop()

    async def close(self) -> None:
        self.remove_tracks()
        if self.pc is not None:
            await self.pc.close()
        for task in list(self._tasks):
            task.cancel()

    # ----------------------------------------------------------- signaling

    async def _signal_worker(self) -> None:
        # One message at a time, in arrival order: a candidate must never be
        # applied ahead of the description it belongs to.
        while True:
            message = await self._signals.get()
            try:
                await self._on_signal(message)
            except Exception:  # noqa: BLE001
                log.exception("Failed to handle signaling message")

    async def _on_signal(self, message: dict) -> None:
        if not isinstance(message, dict):
            log.error("Unable to handle message: %r", message)
            return
        candidate = message.get("candidate", _MISSING)
        description = message.get("sessionDescription")
        camera_info = message.get("cameraInfo")
        nonce = (
            camera_info.get(RENEGOTIATE_CAMERA_INFO_KEY)
            if isinstance(camera_info, dict)
            else None
        )

        if nonce and not description and candidate is _MISSING:
            log.info("Operator requested renegotiation")
            self.robot_renegotiation_nonce = nonce
            self.start_robot_session()
            return

        if isinstance(camera_info, dict):
            stream_info = {
                k: v for k, v in camera_info.items() if k != RENEGOTIATE_CAMERA_INFO_KEY
            }
            if stream_info:
                self.camera_info = stream_info

        pc = self.pc
        if description and description.get("type") in ("offer", "answer"):
            kind = description["type"]
            ready_for_offer = not self.making_offer and pc.signalingState == "stable"
            if kind == "offer" and not ready_for_offer:
                # The robot is the impolite peer: its own offer wins a collision.
                log.error("Ignoring offer")
                return
            try:
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=description["sdp"], type=kind)
                )
                if pc is not self.pc:
                    return
                pending, self.pending_candidates = self.pending_candidates, []
                for queued in pending:
                    await self._add_candidate(pc, queued)
                if kind == "offer":
                    await pc.setLocalDescription(await pc.createAnswer())
                    if pc is not self.pc:
                        return
                    self.signaler.send(
                        {
                            "sessionDescription": {
                                "type": pc.localDescription.type,
                                "sdp": pc.localDescription.sdp,
                            }
                        }
                    )
            except Exception:  # noqa: BLE001
                if pc is self.pc:
                    log.exception("Failed to apply session description")
        elif candidate is not _MISSING:
            if pc.remoteDescription is None:
                self.pending_candidates.append(candidate)
                return
            await self._add_candidate(pc, candidate)
        elif not camera_info:
            log.error("Unable to handle message: %.200s", message)

    async def _add_candidate(self, pc: RTCPeerConnection, candidate) -> None:
        try:
            if not candidate or not candidate.get("candidate"):
                await pc.addIceCandidate(None)  # end of candidates
                return
            text = candidate["candidate"]
            if text.startswith("candidate:"):
                text = text[len("candidate:") :]
            parsed = candidate_from_sdp(text)
            parsed.sdpMid = candidate.get("sdpMid")
            parsed.sdpMLineIndex = candidate.get("sdpMLineIndex")
            await pc.addIceCandidate(parsed)
        except Exception as error:  # noqa: BLE001 - a bad candidate is not fatal
            log.info("Ignoring ICE candidate: %s", error)

    # -------------------------------------------------------- data channel

    def is_open(self) -> bool:
        return self.channel is not None and self.channel.readyState == "open"

    def max_message_size(self) -> int:
        sctp = self.pc.sctp if self.pc is not None else None
        size = getattr(sctp, "_remote_max_message_size", None)
        return size or 65536

    def send_data(self, obj) -> bool:
        if not self.is_open():
            return False
        data = encode_message(obj)
        if len(data.encode("utf-8")) > self.max_message_size():
            log.error(
                "Dropping %d-byte message larger than the peer accepts", len(data)
            )
            return False
        self.channel.send(data)
        return True
