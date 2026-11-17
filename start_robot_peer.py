#!/usr/bin/env python3
"""Start the robot side of web teleop.

Bridges ROS 2 to the operator's browser over WebRTC. Run with ROS 2 sourced
(start_robot_peer.sh does that); start_web_server_and_robot_peer.sh starts it
under pm2.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stretch4_web_teleop_robot.main import main  # noqa: E402

if __name__ == "__main__":
    main()
