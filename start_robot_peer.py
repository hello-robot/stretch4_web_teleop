#!/usr/bin/env python3
"""Start the robot side of web teleop.

Bridges ROS 2 to the operator's browser over WebRTC. web_interface.launch.py
runs it (and restarts it if it exits); to run it by hand, source ROS 2 first.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stretch4_web_teleop_robot.main import main  # noqa: E402

if __name__ == "__main__":
    main()
