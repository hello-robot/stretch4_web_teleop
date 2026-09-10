#!/bin/bash
set -e

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop/stretch4_web_teleop_$(date '+%Y%m%d%H%M')"
STORAGE="localstorage"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)"
export FEATURE_VOICE_CONTROL_INTERFACE

while getopts l:o:f opt; do
	case $opt in
	l)
		# Usage: ./start_web_server_and_robot_browser.sh -l /tmp/some_folder
		if [[ -d $OPTARG ]]; then
			REDIRECT_LOGDIR=$OPTARG
		fi
		;;
	o)
		# Usage: ./start_web_server_and_robot_browser.sh -o /tmp/some_folder/some_file.txt
		# Passed explicitly by launch_interface.sh so both scripts always log to the same file,
		# instead of each independently reconstructing the same filename.
		REDIRECT_LOGFILE=$OPTARG
		;;
	f)
		# Usage: ./start_web_server_and_robot_browser.sh -f
		echo "Using firebase..."
		STORAGE="firebase"
		;;
	esac
done
REDIRECT_LOGFILE="${REDIRECT_LOGFILE:-$REDIRECT_LOGDIR/start_web_server_and_robot_browser.txt}"
mkdir -p "$(dirname "$REDIRECT_LOGFILE")"
echo "Arguments:" &>>$REDIRECT_LOGFILE
echo "-l $REDIRECT_LOGDIR" &>>$REDIRECT_LOGFILE
echo "-f $STORAGE" &>>$REDIRECT_LOGFILE
flags=""
while IFS='=' read -r var value; do
	[[ -n "$flags" ]] && flags+=", "
	flags+="$var: $value"
done < <(node "$REPO_DIR/feature-flags.js" --all)
echo "flags={$flags}" &>>$REDIRECT_LOGFILE

echo "Run webpack..."
export NODE_EXTRA_CA_CERTS="/home/hello-robot/ament_ws/src/stretch4_web_teleop/certificates/rootCA.pem"
cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s npm --name="stretch4_web_teleop" -- run $STORAGE &>>$REDIRECT_LOGFILE

echo "Start local server..."
cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s server.js &>>$REDIRECT_LOGFILE

echo "Start robot browser..."
cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s start_robot_browser.js &>>$REDIRECT_LOGFILE
ifconfig | sed -En 's/127.0.0.1//;s/.*inet (addr:)?(([0-9]*\.){3}[0-9]*).*/https:\/\/\2\/operator/p' &>>$REDIRECT_LOGFILE
