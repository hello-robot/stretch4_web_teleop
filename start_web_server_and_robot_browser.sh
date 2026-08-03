#!/bin/bash
set -e

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop"
mkdir -p $REDIRECT_LOGDIR
STORAGE="localstorage"
while getopts l:f opt; do
	case $opt in
	l)
		# Usage: ./start_web_server_and_robot_browser.sh -l /tmp/some_folder
		if [[ -d $OPTARG ]]; then
			REDIRECT_LOGDIR=$OPTARG
		fi
		;;
	f)
		# Usage: ./start_web_server_and_robot_browser.sh -f
		echo "Using firebase..."
		STORAGE="firebase"
		;;
	esac
done
REDIRECT_LOGFILE="$REDIRECT_LOGDIR/start_web_server_and_robot_browser.$(date '+%Y%m%d%H%M')_redirected.txt"
echo "Arguments:" &>>$REDIRECT_LOGFILE
echo "-l $REDIRECT_LOGDIR" &>>$REDIRECT_LOGFILE
echo "-f $STORAGE" &>>$REDIRECT_LOGFILE

HOSTED_URL="localhost"
if [ "$STORAGE" = "firebase" ]; then
	FIREBASE_RC=".firebaserc"
	if [ -f "$FIREBASE_RC" ]; then
		PROJECT_ID=$(grep -o '"default": "[^"]*' "$FIREBASE_RC" | cut -d'"' -f4)
		if [ ! -z "$PROJECT_ID" ]; then
			HOSTED_URL="${PROJECT_ID}.web.app"
		fi
	fi
	echo "Start robot browser pointing to cloud dashboard: $HOSTED_URL"
	cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s start_robot_browser.js --name="start_robot_browser" --watch -- "$HOSTED_URL" &>>$REDIRECT_LOGFILE
else
	echo "Run webpack..."
	export NODE_EXTRA_CA_CERTS="$HOME/ament_ws/src/stretch4_web_teleop/certificates/rootCA.pem"
	cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s npm --name="stretch4_web_teleop" -- run $STORAGE &>>$REDIRECT_LOGFILE

	echo "Start local server..."
	cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s server.js --watch &>>$REDIRECT_LOGFILE

	echo "Start robot browser..."
	cd ~/ament_ws/src/stretch4_web_teleop && pm2 start -s start_robot_browser.js --watch &>>$REDIRECT_LOGFILE
fi
ifconfig | sed -En 's/127.0.0.1//;s/.*inet (addr:)?(([0-9]*\.){3}[0-9]*).*/https:\/\/\2\/operator/p' &>>$REDIRECT_LOGFILE
