"""Camera and microphone tracks for the WebRTC peer.

Camera frames arrive from ROS as JPEG (sensor_msgs/CompressedImage). Each one
is decoded once, in the ROS callback thread, and handed to every live video
track. The track releases a frame to aiortc's encoder as soon as it arrives,
so the stream runs at the camera's own rate with no resampling, scaling, or
canvas copy in between. When no operator is connected nothing is decoded.
"""

import asyncio
import logging
import threading
import time
from fractions import Fraction
from typing import Any

import av
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack

log = logging.getLogger(__name__)

VIDEO_TIME_BASE = Fraction(1, 90000)


class CameraTrack(MediaStreamTrack):
    """Video track that always delivers the newest decoded camera frame."""

    kind = "video"

    def __init__(self, source: "CameraSource"):
        super().__init__()
        self._source = source
        self._frame = None
        self._ready = asyncio.Event()
        self._start = None

    def _push(self, frame) -> None:
        # Called on the event loop. An unread frame is simply replaced: the
        # encoder should always get the freshest one, never a backlog.
        self._frame = frame
        self._ready.set()

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        await self._ready.wait()
        self._ready.clear()
        if self.readyState != "live":
            raise MediaStreamError
        frame, self._frame = self._frame, None
        now = time.monotonic()
        if self._start is None:
            self._start = now
        frame.pts = int((now - self._start) / VIDEO_TIME_BASE)
        frame.time_base = VIDEO_TIME_BASE
        return frame

    def stop(self) -> None:
        super().stop()
        self._source.remove(self)
        self._ready.set()


class CameraSource:
    """Decodes one camera's JPEG stream and fans frames out to video tracks."""

    def __init__(self, name: str, loop: asyncio.AbstractEventLoop):
        self.name = name
        self.loop = loop
        self._tracks: set[CameraTrack] = set()
        self._lock = threading.Lock()
        self._decoder: Any = av.CodecContext.create("mjpeg", "r")
        self.frames_received = 0
        self.frames_decoded = 0
        self.has_frame = False

    def create_track(self) -> CameraTrack:
        track = CameraTrack(self)
        with self._lock:
            self._tracks.add(track)
        return track

    def remove(self, track: CameraTrack) -> None:
        with self._lock:
            self._tracks.discard(track)

    def on_jpeg(self, data: bytes) -> None:
        """ROS callback thread: decode if anyone is watching, then publish."""
        self.frames_received += 1
        self.has_frame = True
        with self._lock:
            tracks = list(self._tracks)
        if not tracks:
            return
        try:
            frames = self._decoder.decode(av.Packet(bytes(data)))
        except av.FFmpegError as error:
            log.warning("%s: could not decode camera frame: %s", self.name, error)
            return
        if not frames:
            return
        # The encoder wants yuv420p; converting here keeps that work off the
        # event loop and out of the encoder's critical path.
        frame = frames[-1].reformat(format="yuv420p")
        self.frames_decoded += 1
        for track in tracks:
            self.loop.call_soon_threadsafe(track._push, frame)


def _use_system_alsa_config() -> None:
    """Point PyAV's bundled alsa-lib at the system's configuration and plugins.

    The PyAV wheels ship their own alsa-lib, compiled to look for alsa.conf and
    its plugins under a build directory that does not exist on the robot.
    Without them the ``default`` device, which PipeWire / PulseAudio provide
    through an ALSA plugin, cannot be opened.
    """
    import glob
    import os

    if "ALSA_CONFIG_PATH" not in os.environ and os.path.exists(
        "/usr/share/alsa/alsa.conf"
    ):
        os.environ["ALSA_CONFIG_PATH"] = "/usr/share/alsa/alsa.conf"
    if "ALSA_PLUGIN_DIR" not in os.environ:
        plugin_dirs = glob.glob("/usr/lib/*/alsa-lib") + glob.glob("/usr/lib/alsa-lib")
        if plugin_dirs:
            os.environ["ALSA_PLUGIN_DIR"] = plugin_dirs[0]


class Microphone:
    """The robot's microphone, shared by successive sessions.

    ``spec`` is ``<format>:<device>`` as understood by FFmpeg, for example
    ``alsa:default`` (PipeWire and PulseAudio both serve the ALSA default
    device), or ``off``.
    """

    def __init__(self, spec: str):
        self.spec = spec
        self._player: Any = None
        self._relay: Any = None

    def start(self) -> bool:
        if self.spec.lower() in ("", "off", "none", "0"):
            log.info("Robot microphone disabled")
            return False
        from aiortc.contrib.media import MediaPlayer, MediaRelay

        fmt, _, device = self.spec.partition(":")
        if fmt == "alsa":
            _use_system_alsa_config()
        try:
            self._player = MediaPlayer(
                device or "default", format=fmt, options={"channels": "1"}
            )
        except (
            Exception
        ) as error:  # noqa: BLE001 - any capture failure leaves teleop working
            log.error("Robot microphone unavailable (%s): %s", self.spec, error)
            self._player = None
            return False
        if self._player.audio is None:
            log.error("Robot microphone %s has no audio stream", self.spec)
            self._player = None
            return False
        self._relay = MediaRelay()
        log.info("Robot microphone opened: %s", self.spec)
        return True

    def create_track(self):
        if self._player is None:
            return None
        return self._relay.subscribe(self._player.audio, buffered=False)

    def stop(self) -> None:
        """Stop the capture thread before the event loop it feeds goes away."""
        if self._player is not None and self._player.audio is not None:
            self._player.audio.stop()
        self._player = None
