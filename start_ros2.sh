#!/bin/bash
set -e

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop"
mkdir -p $REDIRECT_LOGDIR
# -t was declared here for years with no case arm to receive it, so the mode
# flag the other launch scripts take was silently swallowed. Unknown flags now
# stop the script rather than scroll past.
while getopts l:m: opt; do
	case $opt in
	l)
		# Usage: ./start_ros2.sh -l /tmp/some_folder
		if [[ -d $OPTARG ]]; then
			REDIRECT_LOGDIR=$OPTARG
		fi
		;;
	m)
		# Usage: ./start_ros2.sh -m $HELLO_FLEET_PATH/maps/<map_name>.yaml
		if [[ -f $OPTARG ]]; then
			echo "Setting map..."
			MAP_ARG="map_yaml:=$OPTARG"
		fi
		;;
	*)
		echo "Usage: $0 [-l logdir] [-m map.yaml]"
		exit 1
		;;
	esac
done
REDIRECT_LOGFILE="$REDIRECT_LOGDIR/start_ros2.$(date '+%Y%m%d%H%M')_redirected.txt"
echo "Arguments:" &>>$REDIRECT_LOGFILE
echo "-l $REDIRECT_LOGDIR" &>>$REDIRECT_LOGFILE
echo "-m $MAP_ARG" &>>$REDIRECT_LOGFILE

echo ""
echo "Setup environment..."
teleop_setup_env

echo "Stopping previous instances..."
"$REPO_DIR/stop_interface.sh" &>>$REDIRECT_LOGFILE || true

echo "Reload USB bus..."
# Needs root. The daemon reaches this script as an unprivileged user, so skip
# the reload there rather than block on a password prompt nothing can answer.
if sudo -n true 2>/dev/null; then
	sudo -n udevadm control --reload-rules &>>$REDIRECT_LOGFILE || true
	sudo -n udevadm trigger &>>$REDIRECT_LOGFILE || true
else
	echo "Skipping USB bus reload (no passwordless sudo)."
fi

echo "Check rmw_zenohd..."
if ! pgrep -x rmw_zenohd >/dev/null; then
	echo "rmw_zenohd not running, starting it..."
	screen -dm -S "rmw_zenohd" bash -c "export PATH=\"\$HOME/.local/bin:\$PATH\" && export RMW_IMPLEMENTATION=rmw_zenoh_cpp && source /opt/ros/jazzy/setup.bash && source ~/ament_ws/install/setup.bash && ros2 run rmw_zenoh_cpp rmw_zenohd &>> $REDIRECT_LOGDIR/rmw_zenohd.txt"
	sleep 2
	if ! pgrep -x rmw_zenohd >/dev/null; then
		echo "ERROR: Failed to start rmw_zenohd. See logs: $REDIRECT_LOGDIR/rmw_zenohd.txt"
		exit 1
	fi
	echo "rmw_zenohd started."
else
	echo "rmw_zenohd already running."
fi

FEATURE_LOCAL_COLLISION_AVOIDANCE="$(node "$REPO_DIR/feature-flags.js" local_collision_avoidance)" || exit 1
export FEATURE_LOCAL_COLLISION_AVOIDANCE

FEATURE_EE_VELOCITY_LIMITER="$(node "$REPO_DIR/feature-flags.js" ee_velocity_limiter)" || exit 1
export FEATURE_EE_VELOCITY_LIMITER

LAUNCH_LOGFILE="$REDIRECT_LOGDIR/web_interface_launch.txt"
echo "Start ROS2..."
echo "ROS2 launch output: $LAUNCH_LOGFILE"
screen -dm -S "web_teleop_ros" bash -c "export RMW_IMPLEMENTATION=rmw_zenoh_cpp && ros2 launch stretch4_web_teleop web_interface.launch.py $MAP_ARG > $LAUNCH_LOGFILE 2>&1"
sleep 8

# Check if the launch log contains any errors
ERRORS=$(grep -E "ERROR" "$LAUNCH_LOGFILE" | grep -vE "Model name OAK-FFC-3P not found|load firetimes error|Inflation layer either not found|rcl_shutdown already called" || true)
if [ -n "$ERRORS" ]; then
	echo ""
	echo "Errors found in web_interface.launch.py output:"
	echo "$ERRORS"
	exit 1
fi
