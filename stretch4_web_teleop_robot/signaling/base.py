from dataclasses import dataclass
from typing import Callable


@dataclass
class Callbacks:
    """What a transport reports to the WebRTC connection."""

    on_signal: Callable[[dict], None]
    on_goodbye: Callable[[], None]
    on_robot_connection_start: Callable[[], None]


class Signaling:
    """Interface shared by every robot-side transport."""

    def __init__(self, callbacks: Callbacks):
        self.callbacks = callbacks

    async def configure(self, room_name: str) -> None:
        """Prepare to join; may log in or open subscriptions."""

    async def join_as_robot(self) -> bool:
        raise NotImplementedError

    def leave(self) -> None:
        raise NotImplementedError

    def send(self, signal: dict) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        """Release network resources at shutdown."""
