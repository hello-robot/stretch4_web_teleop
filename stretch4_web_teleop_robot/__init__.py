"""Robot side of Stretch web teleop.

A native WebRTC peer that bridges ROS 2 to the operator's browser. ROS
messages are handled in-process with rclpy, and camera JPEGs are decoded once
and handed straight to the WebRTC video encoder (aiortc). See
src/primer_robot.md.

Entry point: ``start_robot_peer.py`` at the repository root.
"""
