# shellcheck shell=bash
# Robot environment shared by every launch path.
#
# Source this; do not execute it. The variables have to land in the caller's
# own shell, which a subprocess cannot do. Sourcing twice is harmless.

# Put the robot's ROS environment in place: fleet identity, middleware, and
# the workspace overlay. Safe to call more than once in the same shell.
function teleop_setup_env {
	case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*) export PATH="$HOME/.local/bin:$PATH" ;;
	esac

	# Defines HELLO_FLEET_ID. Absent on a developer machine, where the caller
	# may have exported it by hand.
	if [ -f /etc/hello-robot/hello-robot.conf ]; then
		. /etc/hello-robot/hello-robot.conf
	fi
	export HELLO_FLEET_ID
	export HELLO_FLEET_PATH="${HELLO_FLEET_PATH:-$HOME/stretch_user}"
	export RMW_IMPLEMENTATION=rmw_zenoh_cpp

	source /opt/ros/jazzy/setup.bash &>/dev/null || true
	source "$HOME/ament_ws/install/setup.bash" &>/dev/null || true
	if [ -f /usr/share/colcon_cd/function/colcon_cd.sh ]; then
		source /usr/share/colcon_cd/function/colcon_cd.sh &>/dev/null || true
	fi
}
