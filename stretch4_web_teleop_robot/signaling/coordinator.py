"""Listen on the local and the Firebase door at once.

Only one transport may hold an operator session at a time; an operator arriving through the other
door waits until the active one says goodbye.
"""

import asyncio
import logging

from .base import Callbacks, Signaling

log = logging.getLogger(__name__)

FIREBASE_RETRY_S = 30.0


class TransportGate:
    def __init__(self):
        self.active: str | None = None

    def activate(self, transport: str) -> bool:
        if self.active and self.active != transport:
            return False
        self.active = transport
        return True

    def accepts(self, transport: str) -> bool:
        return self.active == transport

    def goodbye(self, transport: str) -> bool:
        if self.active != transport:
            return False
        self.active = None
        return True

    def reset(self) -> None:
        self.active = None


class TeleopSignalingCoordinator(Signaling):
    def __init__(self, callbacks: Callbacks, local_factory, firebase_factory):
        super().__init__(callbacks)
        self.gate = TransportGate()
        self.pending_transport: str | None = None
        self.local_joined = False
        self.firebase_joined = False
        self.firebase_ready: asyncio.Future | None = None
        self.firebase_join_task: asyncio.Task | None = None
        self.join_epoch = 0
        self.local = local_factory(self._transport_callbacks("local"))
        self.firebase = firebase_factory(self._transport_callbacks("firebase"))

    def _transport_callbacks(self, transport: str) -> Callbacks:
        def on_signal(signal):
            if self.gate.accepts(transport):
                self.callbacks.on_signal(signal)

        def on_robot_connection_start():
            if not self.gate.activate(transport):
                self.pending_transport = transport
                log.warning(
                    "Ignoring %s operator while another transport is active", transport
                )
                return
            self.pending_transport = None
            self.callbacks.on_robot_connection_start()

        def on_goodbye():
            if not self.gate.goodbye(transport):
                return
            self.callbacks.on_goodbye()
            pending, self.pending_transport = self.pending_transport, None
            if pending and self.gate.activate(pending):
                self.callbacks.on_robot_connection_start()

        return Callbacks(on_signal, on_goodbye, on_robot_connection_start)

    async def configure(self, room_name: str) -> None:
        """Configure both; only the local transport can fail this call."""
        loop = asyncio.get_running_loop()

        async def configure_firebase() -> bool:
            try:
                await self.firebase.configure(room_name)
                return True
            except (
                Exception
            ) as error:  # noqa: BLE001 - the cloud must not cost us the LAN door
                log.error(
                    "Firebase signaling unavailable; local teleop continues: %s", error
                )
                return False

        self.firebase_ready = loop.create_task(configure_firebase())
        await self.local.configure(room_name)

    async def join_as_robot(self) -> bool:
        self._join_firebase_in_background()
        if self.local_joined:
            return True
        self.local_joined = await self.local.join_as_robot()
        return self.local_joined

    def _join_firebase_in_background(self) -> None:
        if self.firebase_joined or (
            self.firebase_join_task and not self.firebase_join_task.done()
        ):
            return
        epoch = self.join_epoch

        async def join():
            while epoch == self.join_epoch:
                ready = await self.firebase_ready if self.firebase_ready else False
                if not ready:
                    return  # a failed configure is terminal for this run
                try:
                    joined = await self.firebase.join_as_robot()
                except Exception as error:  # noqa: BLE001
                    log.error(
                        "Firebase robot join failed; local teleop continues: %s", error
                    )
                    joined = False
                if epoch != self.join_epoch:
                    return
                self.firebase_joined = joined
                if joined:
                    return
                await asyncio.sleep(FIREBASE_RETRY_S)

        self.firebase_join_task = asyncio.get_running_loop().create_task(join())

    def leave(self) -> None:
        self.join_epoch += 1
        if self.firebase_join_task and not self.firebase_join_task.done():
            self.firebase_join_task.cancel()
        self.gate.reset()
        self.pending_transport = None
        self.local_joined = False
        self.firebase_joined = False
        self.local.leave()
        self.firebase.leave()

    def send(self, signal: dict) -> None:
        if self.gate.accepts("local"):
            self.local.send(signal)
        elif self.gate.accepts("firebase"):
            self.firebase.send(signal)

    async def close(self) -> None:
        await self.local.close()
        await self.firebase.close()
