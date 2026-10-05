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
# Inherited by pm2-started Node processes (server.js voiceInteractionLogger),
# so JSONL logs and audio-snippet clips land in this run's timestamped dir.
export REDIRECT_LOGDIR
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

# Local and Firebase builds stay in separate folders so one launch cannot
# serve the other mode's bundle. Firebase Hosting publishes dist-firebase.
BUILD_MODE="${WEB_TELEOP_BUILD_MODE:-development}"
if [[ "$BUILD_MODE" != "development" && "$BUILD_MODE" != "production" ]]; then
	echo "WEB_TELEOP_BUILD_MODE must be development or production."
	exit 1
fi

export NODE_EXTRA_CA_CERTS="$REPO_DIR/certificates/rootCA.pem"
if [ "$STORAGE" = "firebase" ]; then
	export WEB_TELEOP_DIST="dist-firebase"
	export WEB_TELEOP_DUAL=1
	echo "Dual teleop: Tailscale uses local signaling; Hosting uses Firebase."
	if [ "$BUILD_MODE" = "development" ]; then
		echo "Start hosting preview autodeploy..."
		cd "$REPO_DIR" && pm2 start -s scripts/firebase_hosting_autodeploy.js --name="firebase_hosting_autodeploy" &>>$REDIRECT_LOGFILE
		echo "Start local and Firebase webpack watchers..."
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop_local" -- run localstorage -- --env dual=true &>>$REDIRECT_LOGFILE
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop_firebase" -- run firebase -- --env dual=true &>>$REDIRECT_LOGFILE
	else
		echo "Build local and Firebase production bundles..."
		cd "$REPO_DIR" && npm run build:localstorage -- --env dual=true &>>$REDIRECT_LOGFILE
		cd "$REPO_DIR" && npm run build:firebase -- --env dual=true &>>$REDIRECT_LOGFILE
	fi
	node "$REPO_DIR/scripts/waitForBundles.js" \
		dist/operator/index.html \
		dist-firebase/index.html \
		dist-firebase/operator/index.html \
		dist-firebase/robot/index.html
else
	export WEB_TELEOP_DIST="dist"
	export WEB_TELEOP_DUAL=0
	if [ "$BUILD_MODE" = "development" ]; then
		echo "Start local webpack watcher..."
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop" -- run localstorage &>>$REDIRECT_LOGFILE
	else
		echo "Build local production bundle..."
		cd "$REPO_DIR" && npm run build:localstorage &>>$REDIRECT_LOGFILE
	fi
	node "$REPO_DIR/scripts/waitForBundles.js" \
		dist/index.html \
		dist/operator/index.html \
		dist/robot/index.html
fi

echo "Start local server..."
cd "$REPO_DIR" && pm2 start -s server.js &>>$REDIRECT_LOGFILE

echo "Start robot browser..."
cd "$REPO_DIR" && pm2 start -s start_robot_browser.js &>>$REDIRECT_LOGFILE
ifconfig | sed -En 's/127.0.0.1//;s/.*inet (addr:)?(([0-9]*\.){3}[0-9]*).*/https:\/\/\2\/operator/p' &>>$REDIRECT_LOGFILE
