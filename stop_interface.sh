#!/bin/bash

# Usage: ./stop_interface.sh
# Tear down a running web teleop stack: the ROS screens, the middleware, and
# the pm2 processes. Safe to run when nothing is up, and safe to run as an
# unprivileged user -- the daemon reaches this through start_ros2.sh.
screen -S "web_teleop_ros" -X stuff '^C' 2>/dev/null || true
screen -S "rmw_zenohd" -X stuff '^C' 2>/dev/null || true
sleep 3

# Whatever ignored the interrupt, or was started outside a screen. Scoped to
# this user, so it needs no sudo and cannot touch anyone else's processes.
pkill -u "$USER" -f web_interface.launch.py 2>/dev/null || true
pkill -u "$USER" -f rmw_zenohd 2>/dev/null || true

pm2 kill 2>/dev/null || true
exit 0
