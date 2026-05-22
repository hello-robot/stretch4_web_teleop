#!/bin/bash
set -e

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop"
mkdir -p $REDIRECT_LOGDIR
while getopts l:m:t: opt; do
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
	esac
done
REDIRECT_LOGFILE="$REDIRECT_LOGDIR/start_ros2.$(date '+%Y%m%d%H%M')_redirected.txt"
echo "Arguments:" &>>$REDIRECT_LOGFILE
echo "-l $REDIRECT_LOGDIR" &>>$REDIRECT_LOGFILE
echo "-m $MAP_ARG" &>>$REDIRECT_LOGFILE

echo ""
echo "Setup environment..."
. /etc/hello-robot/hello-robot.conf
export HELLO_FLEET_ID HELLO_FLEET_ID
export HELLO_FLEET_PATH=$HOME/stretch_user
source /opt/ros/jazzy/setup.bash &>>$REDIRECT_LOGFILE
source ~/ament_ws/install/setup.bash &>>$REDIRECT_LOGFILE
source /usr/share/colcon_cd/function/colcon_cd.sh &>>$REDIRECT_LOGFILE

echo "Stopping previous instances..."
./stop_interface.sh &>>$REDIRECT_LOGFILE

echo "Reload USB bus..."
sudo udevadm control --reload-rules && sudo udevadm trigger &>>$REDIRECT_LOGFILE

echo "Check rmw_zenohd..."
if ! pgrep -x rmw_zenohd >/dev/null; then
	echo "rmw_zenohd not running, starting it..."
	screen -dm -S "rmw_zenohd" bash -c "source /opt/ros/jazzy/setup.bash && source ~/ament_ws/install/setup.bash && ros2 run rmw_zenoh_cpp rmw_zenohd &>> $REDIRECT_LOGDIR/rmw_zenohd.txt"
	sleep 2
	if ! pgrep -x rmw_zenohd >/dev/null; then
		echo "ERROR: Failed to start rmw_zenohd. See logs: $REDIRECT_LOGDIR/rmw_zenohd.txt"
		exit 1
	fi
	echo "rmw_zenohd started."
else
	echo "rmw_zenohd already running."
fi

LAUNCH_LOGFILE="$REDIRECT_LOGDIR/web_interface_launch.txt"
echo "Start ROS2..."
echo "ROS2 launch output: $LAUNCH_LOGFILE"
screen -dm -S "web_teleop_ros" bash -c "ros2 launch stretch4_web_teleop web_interface.launch.py $MAP_ARG &>> $LAUNCH_LOGFILE"
sleep 8

# Check if the launch log contains any errors
ERRORS=$(grep -E "ERROR" "$LAUNCH_LOGFILE" || true)
if [ -n "$ERRORS" ]; then
	echo ""
	echo "Errors found in web_interface.launch.py output:"
	echo "$ERRORS"
	exit 1
fi
