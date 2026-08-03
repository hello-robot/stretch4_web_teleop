#!/bin/bash
set -e

# Define color variables
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

timestamp='stretch4_web_teleop_'$(date '+%Y%m%d%H%M')
logdir="$HOME/stretch_user/log/web_teleop/$timestamp"
logfile_node="$logdir/start_web_server_and_robot_browser.txt"
mkdir -p $logdir

echo -e "${BLUE}Launching Web Teleop via Firebase Onboard...${NC}"

# Setup environment
export PATH="$HOME/.local/bin:$PATH"
. /etc/hello-robot/hello-robot.conf
export HELLO_FLEET_ID
export HELLO_FLEET_PATH=$HOME/stretch_user
source /opt/ros/jazzy/setup.bash &>/dev/null || true
source ~/ament_ws/install/setup.bash &>/dev/null || true

# 1. Stop any legacy or previous instances safely without sudo
echo "Stopping previous instances..."
screen -S "web_teleop_ros" -X stuff '^C' 2>/dev/null || true
screen -S "rmw_zenohd" -X stuff '^C' 2>/dev/null || true
sleep 2
pkill -u $USER -f web_interface.launch.py 2>/dev/null || true
pkill -u $USER -f rmw_zenohd 2>/dev/null || true
pm2 kill 2>/dev/null || true

# 2. Check and start rmw_zenohd if not already running
echo "Check rmw_zenohd..."
if ! pgrep -x rmw_zenohd >/dev/null; then
	echo "rmw_zenohd not running, starting it..."
	screen -dm -S "rmw_zenohd" bash -c "export PATH=\"\$HOME/.local/bin:\$PATH\" && source /opt/ros/jazzy/setup.bash && source ~/ament_ws/install/setup.bash && ros2 run rmw_zenoh_cpp rmw_zenohd &>> $logdir/rmw_zenohd.txt"
	sleep 2
fi

# 3. Start ROS2 launch file
echo "Start ROS2..."
LAUNCH_LOGFILE="$logdir/web_interface_launch.txt"
screen -dm -S "web_teleop_ros" bash -c "export PATH=\"\$HOME/.local/bin:\$PATH\" && source /opt/ros/jazzy/setup.bash && source ~/ament_ws/install/setup.bash && ros2 launch stretch4_web_teleop web_interface.launch.py > $LAUNCH_LOGFILE 2>&1"
sleep 8

# 4. Start the robot browser (pointing to Firebase)
echo "Start robot browser..."
cd "$HOME/ament_ws/src/stretch4_web_teleop"
./start_web_server_and_robot_browser.sh -l $logdir -f |& tee $logfile_node

echo -e "${GREEN}✓ Onboard launch completed successfully!${NC}"
