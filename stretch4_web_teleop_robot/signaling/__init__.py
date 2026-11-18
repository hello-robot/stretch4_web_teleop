"""Signaling transports for the robot peer.

Ports of src/shared/signaling: LocalSignaling (socket.io to server.js),
FirebaseSignaling (Realtime Database), and the TeleopSignalingCoordinator the
robot uses to listen on both when the cloud door is open.
"""

import os

from .base import Callbacks


def create_signaler(on_signal, on_goodbye, on_robot_connection_start):
    """Pick transports from HOSTING_MODE: the LAN door always, the cloud door too in firebase mode."""
    from .local import LocalSignaling

    callbacks = Callbacks(on_signal, on_goodbye, on_robot_connection_start)
    hosting_mode = os.environ.get("HOSTING_MODE", "local")
    server_url = os.environ.get("WEB_TELEOP_SERVER_URL", "https://localhost")
    if hosting_mode == "firebase":
        from .coordinator import TeleopSignalingCoordinator
        from .firebase import FirebaseConfig, FirebaseSignaling

        config = FirebaseConfig.from_env()
        return TeleopSignalingCoordinator(
            callbacks,
            local_factory=lambda cb: LocalSignaling(cb, server_url),
            firebase_factory=lambda cb: FirebaseSignaling(cb, config),
        )
    return LocalSignaling(callbacks, server_url)
