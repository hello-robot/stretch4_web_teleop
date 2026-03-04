#!/bin/bash

# Names for screen sessions
SESSION1="zenohd_session"
SESSION2="stretch_body_session"
SESSION3="oak_camera_session"
SESSION4="luxonis_session"

# Start rmw_zenohd in its own screen session
screen -dmS $SESSION1 bash -c "ros2 run rmw_zenoh_cpp rmw_zenohd; exec bash"

# Start stretch_body_server.py in its own screen session
screen -dmS $SESSION2 bash -c "stretch_body_server.py --launch; exec bash"

# screen -dmS $SESSION3 bash -c "ros2 launch depthai_ros_driver sr_rgbd_pcl.launch.py; exec bash"

screen -dmS $SESSION4 bash -c "ros2 launch stretch_core luxonis.launch.py use_center:=true; exec bash"

echo "Started:"
echo " - $SESSION1 (ros2 zenoh daemon)"
echo " - $SESSION2 (stretch body server)"
echo " - $SESSION3 (oak camera)"
echo " - $SESSION4 (luxonis)"
echo ""
