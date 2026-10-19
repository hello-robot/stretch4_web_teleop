#!/bin/bash
# The shared launch spine.
#
# Brings up the robot environment, then ROS, then the web server and robot
# browser in the requested teleop mode. Both front doors call this -- the
# hand-run launch_interface.sh and the daemon's launch_interface_firebase.sh --
# so ROS comes up exactly one way no matter who asked.
#
# Usage: ./launch_teleop_stack.sh [--hosting local|firebase|dual] [-m map.yaml] [-l logdir]
#
# --hosting picks which host serves the operator UI: local is the robot's own
# server, firebase is Firebase Hosting, dual is both. Defaults to dual.
set -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"
source "$REPO_DIR/scripts/lib/teleop_config.sh"

HOSTING_MODE="dual"
MAP=""
LOGDIR=""
usage() {
	echo "Usage: $0 [--hosting local|firebase|dual] [-m map.yaml] [-l logdir]"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--hosting)
		shift
		if [ $# -eq 0 ]; then
			echo "--hosting needs local, firebase, or dual."
			exit 1
		fi
		HOSTING_MODE="$1"
		;;
	--hosting=*) HOSTING_MODE="${1#--hosting=}" ;;
	-m)
		shift
		if [ $# -eq 0 ]; then
			echo "-m needs a path to a map .yaml."
			exit 1
		fi
		if [ -f "$1" ]; then
			MAP="-m $1"
		fi
		;;
	-l)
		shift
		if [ $# -eq 0 ]; then
			echo "-l needs a directory."
			exit 1
		fi
		LOGDIR="$1"
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1"
		usage >&2
		exit 1
		;;
	esac
	shift
done

if [[ "$HOSTING_MODE" != "local" && "$HOSTING_MODE" != "firebase" && "$HOSTING_MODE" != "dual" ]]; then
	echo "--hosting must be local, firebase, or dual."
	exit 1
fi

teleop_setup_env
teleop_resolve_build_mode
LOGDIR="$(teleop_log_dir "$LOGDIR")"
LOGFILE_ROS="$LOGDIR/start_ros2.txt"
LOGFILE_NODE="$LOGDIR/start_web_server_and_robot_browser.txt"

cd "$REPO_DIR"
./start_ros2.sh -l "$LOGDIR" $MAP |& tee "$LOGFILE_ROS"
if [ $? -ne 0 ]; then
	exit 1
fi

./start_web_server_and_robot_browser.sh -l "$LOGDIR" -o "$LOGFILE_NODE" --hosting "$HOSTING_MODE" |& tee -a "$LOGFILE_NODE"
