#!/bin/bash

# Usage: ./stop_interface.sh
# Tear down a running web teleop stack: the ROS screens, the middleware, and
# the pm2 processes. Safe to run when nothing is up, and safe to run as an
# unprivileged user -- the daemon reaches this through start_ros2.sh.
screen -S "web_teleop_ros" -X stuff '^C' 2>/dev/null || true
screen -S "rmw_zenohd" -X stuff '^C' 2>/dev/null || true

# Wait for the launch to exit, not just to be asked to. Until it does it holds
# the stretch_core and stretch_nav2 launch locks, so a launch started now would
# find the driver and cameras "already running", skip them, and lose them a
# moment later when this one finishes exiting. ros2 launch escalates to SIGKILL
# on its own nodes after about 10s.
function launch_running {
	pgrep -u "$USER" -f web_interface.launch.py >/dev/null 2>&1
}
for _ in $(seq 1 15); do
	launch_running || break
	sleep 1
done

# Whatever ignored the interrupt, or was started outside a screen.
if launch_running; then
	pkill -u "$USER" -f web_interface.launch.py 2>/dev/null || true
	for _ in $(seq 1 5); do
		launch_running || break
		sleep 1
	done
	pkill -KILL -u "$USER" -f web_interface.launch.py 2>/dev/null || true
fi

# start_ros2.sh starts a router only when none is running, so let this one go first.
for _ in $(seq 1 5); do
	screen -ls 2>/dev/null | grep -q '\.rmw_zenohd[[:space:]]' || break
	sleep 1
done

pm2 kill 2>/dev/null || true
exit 0
