#!/bin/bash
set -e

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop/stretch4_web_teleop_$(date '+%Y%m%d%H%M')"
HOSTING_MODE="dual"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)"
export FEATURE_VOICE_CONTROL_INTERFACE

usage() {
	echo "Usage: $0 [--hosting local|firebase|dual] [-f] [-l logdir] [-o logfile]"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--hosting)
		# Which host serves the operator UI, and so which bundles to build.
		#   local    robot's server serves dist/
		#   firebase Firebase Hosting serves dist-firebase/
		#   dual     both; dist-firebase/ at / with dist/ at /local/
		shift
		if [ $# -eq 0 ]; then
			echo "--hosting needs local, firebase, or dual."
			exit 1
		fi
		HOSTING_MODE="$1"
		;;
	--hosting=*) HOSTING_MODE="${1#--hosting=}" ;;
	-f)
		# Firebase only. Shorthand for --hosting firebase.
		HOSTING_MODE="firebase"
		;;
	-l)
		shift
		if [ $# -gt 0 ] && [ -d "$1" ]; then
			REDIRECT_LOGDIR="$1"
		fi
		;;
	-o)
		# Passed explicitly by launch_teleop_stack.sh so both scripts always log
		# to the same file, instead of each rebuilding the same filename.
		shift
		if [ $# -eq 0 ]; then
			echo "-o needs a file path."
			exit 1
		fi
		REDIRECT_LOGFILE="$1"
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
# Inherited by pm2-started Node processes (server.js voiceInteractionLogger),
# so JSONL logs and audio-snippet clips land in this run's timestamped dir.
export REDIRECT_LOGDIR
REDIRECT_LOGFILE="${REDIRECT_LOGFILE:-$REDIRECT_LOGDIR/start_web_server_and_robot_browser.txt}"
mkdir -p "$(dirname "$REDIRECT_LOGFILE")"
echo "Arguments:" &>>$REDIRECT_LOGFILE
echo "-l $REDIRECT_LOGDIR" &>>$REDIRECT_LOGFILE
echo "--hosting $HOSTING_MODE" &>>$REDIRECT_LOGFILE
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
if [[ "$HOSTING_MODE" != "local" && "$HOSTING_MODE" != "firebase" && "$HOSTING_MODE" != "dual" ]]; then
	echo "--hosting must be local, firebase, or dual."
	exit 1
fi

export NODE_EXTRA_CA_CERTS="$REPO_DIR/certificates/rootCA.pem"

# Bundles left by an earlier run satisfy waitForBundles.js on sight, which
# would pass a build that never ran. Clear them so the wait tests this build.
function clear_bundles {
	rm -rf "$REPO_DIR/dist" "$REPO_DIR/dist-firebase"
}

# Hosting uploads only ever publish dist-firebase, so both cloud modes want
# the watcher. launch_interface.sh clears the flag when the CLI cannot deploy.
function start_hosting_autodeploy {
	if [ "${WEB_TELEOP_AUTODEPLOY:-1}" = 0 ]; then
		echo "Hosting preview autodeploy disabled."
		return 0
	fi
	echo "Start hosting preview autodeploy..."
	cd "$REPO_DIR" && pm2 start -s scripts/firebase_hosting_autodeploy.js --name="firebase_hosting_autodeploy" &>>$REDIRECT_LOGFILE || return 1
}

# Firebase signaling alone. No local bundle is built, so this robot is
# reachable through a Firebase dashboard and not over Tailscale.
function start_firebase_mode {
	export WEB_TELEOP_DIST="dist-firebase"
	export WEB_TELEOP_DUAL=0
	echo "Firebase teleop: signaling and operator UI come from Firebase."
	clear_bundles
	start_hosting_autodeploy || return 1
	if [ "$BUILD_MODE" = "development" ]; then
		echo "Start Firebase webpack watcher..."
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop" -- run firebase &>>$REDIRECT_LOGFILE || return 1
	else
		echo "Build Firebase production bundle..."
		cd "$REPO_DIR" && npm run build:firebase &>>$REDIRECT_LOGFILE || return 1
	fi
	node "$REPO_DIR/scripts/waitForBundles.js" \
		dist-firebase/index.html \
		dist-firebase/operator/index.html \
		dist-firebase/robot/index.html || return 1
}

# Both transports at once. The robot page runs TeleopSignalingCoordinator, so
# Tailscale uses local signaling while Hosting uses Firebase.
function start_dual_mode {
	export WEB_TELEOP_DIST="dist-firebase"
	export WEB_TELEOP_DUAL=1
	echo "Dual teleop: Tailscale uses local signaling; Hosting uses Firebase."
	clear_bundles
	start_hosting_autodeploy || return 1
	if [ "$BUILD_MODE" = "development" ]; then
		echo "Start local and Firebase webpack watchers..."
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop_local" -- run localstorage -- --env dual=true &>>$REDIRECT_LOGFILE || return 1
		cd "$REPO_DIR" && pm2 start -s npm --name="stretch4_web_teleop_firebase" -- run firebase -- --env dual=true &>>$REDIRECT_LOGFILE || return 1
	else
		echo "Build local and Firebase production bundles..."
		cd "$REPO_DIR" && npm run build:localstorage -- --env dual=true &>>$REDIRECT_LOGFILE || return 1
		cd "$REPO_DIR" && npm run build:firebase -- --env dual=true &>>$REDIRECT_LOGFILE || return 1
	fi
	node "$REPO_DIR/scripts/waitForBundles.js" \
		dist/operator/index.html \
		dist-firebase/index.html \
		dist-firebase/operator/index.html \
		dist-firebase/robot/index.html || return 1
}

# Dual mode builds dist/ with publicPath /local/, which a local-only server
# cannot serve, so dist/ is removed for a rebuild rather than reused.
function stop_cloud_mode {
	local proc
	for proc in firebase_hosting_autodeploy stretch4_web_teleop stretch4_web_teleop_firebase stretch4_web_teleop_local; do
		pm2 delete "$proc" &>>$REDIRECT_LOGFILE || true
	done
	if [ -n "$REPO_DIR" ]; then
		clear_bundles
	fi
}

function start_local_mode {
	export WEB_TELEOP_DIST="dist"
	export WEB_TELEOP_DUAL=0
	clear_bundles
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
}

# Only dual mode may degrade. It was asked for both transports and local still
# works without Firebase, so it keeps the half that survived. A launch asked
# for Firebase alone has no second route to fall back to, and says so by
# exiting non-zero -- which is how the daemon learns the launch failed.
if [ "$HOSTING_MODE" = "firebase" ] && ! start_firebase_mode; then
	stop_cloud_mode
	echo "Firebase setup failed."
	echo "--hosting firebase (failed)" &>>$REDIRECT_LOGFILE
	mkdir -p "$REDIRECT_LOGDIR"
	echo "failed" >"$REDIRECT_LOGDIR/hosting_mode"
	exit 1
fi
if [ "$HOSTING_MODE" = "dual" ] && ! start_dual_mode; then
	stop_cloud_mode
	echo "Firebase setup failed. Falling back to local hosting."
	HOSTING_MODE="local"
	echo "--hosting $HOSTING_MODE (after fallback)" &>>$REDIRECT_LOGFILE
fi
if [ "$HOSTING_MODE" = "local" ]; then
	start_local_mode
fi

# The caller asked for a mode; this is the one that started. launch_interface.sh
# reads it so it never advertises a route this robot did not actually bring up.
mkdir -p "$REDIRECT_LOGDIR"
echo "$HOSTING_MODE" >"$REDIRECT_LOGDIR/hosting_mode"

echo "Start local server..."
cd "$REPO_DIR" && pm2 start -s server.js &>>$REDIRECT_LOGFILE

echo "Start robot browser..."
cd "$REPO_DIR" && pm2 start -s start_robot_browser.js &>>$REDIRECT_LOGFILE
ifconfig | sed -En 's/127.0.0.1//;s/.*inet (addr:)?(([0-9]*\.){3}[0-9]*).*/https:\/\/\2\/operator/p' &>>$REDIRECT_LOGFILE
