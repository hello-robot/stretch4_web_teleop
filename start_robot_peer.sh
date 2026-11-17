#!/bin/bash
# pm2 entry point for the robot peer (start_robot_peer.py).
#
# pm2 runs this from whatever shell started it, which on a dashboard launch has
# no ROS environment. Put the robot's environment in place (ROS 2, the
# workspace overlay, rmw_zenoh, fleet id) and replace this shell with Python,
# so pm2's SIGINT reaches the peer directly and it can stop the robot and
# release its signaling seat.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unset VIRTUAL_ENV PYTHONHOME
# shellcheck source=scripts/lib/teleop_env.sh
source "$REPO_DIR/scripts/lib/teleop_env.sh"
teleop_setup_env
exec python3 "$REPO_DIR/start_robot_peer.py" "$@"
