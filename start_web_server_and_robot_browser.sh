#!/bin/bash
set -e

REDIRECT_LOGDIR="$HOME/stretch_user/log/web_teleop/stretch4_web_teleop_$(date '+%Y%m%d%H%M')"
HOSTING_MODE="${HOSTING_MODE:-local}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
	echo "Usage: $0 [--hosting [local|firebase]] [-f|--firebase] [--local] [-l logdir] [-o logfile]"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--hosting)
		# Whether the cloud door is opened as well as the LAN one, and so which
		# bundles to build.
		#   local     dist/ only; / and /local/ both serve it (default)
		#   firebase  dist-firebase/ at / with dist/ at /local/
		if [ $# -gt 1 ] && [[ "$2" != -* ]]; then
			shift
			HOSTING_MODE="$1"
		else
			HOSTING_MODE="local"
		fi
		;;
	--hosting=*)
		HOSTING_MODE="${1#--hosting=}"
		HOSTING_MODE="${HOSTING_MODE:-local}"
		;;
	-f | --firebase) HOSTING_MODE="firebase" ;;
	--local) HOSTING_MODE="local" ;;
	-l)
		shift
		if [ $# -gt 0 ] && [ -d "$1" ]; then
			REDIRECT_LOGDIR="$1"
		fi
		;;
	-o)
		# Passed explicitly by launch_interface.sh so both scripts always log
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

FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)"
export FEATURE_VOICE_CONTROL_INTERFACE

# Watch-and-rebuild, or a one-shot production build. Resolved by
# launch_interface.sh and inherited; defaulted again here so this script
# still runs when it is called on its own.
BUILD_MODE="${WEB_TELEOP_BUILD_MODE:-development}"
if [[ "$BUILD_MODE" != "development" && "$BUILD_MODE" != "production" ]]; then
	echo "WEB_TELEOP_BUILD_MODE must be development or production."
	exit 1
fi
if [[ "$HOSTING_MODE" != "local" && "$HOSTING_MODE" != "firebase" ]]; then
	echo "HOSTING_MODE must be local or firebase."
	exit 1
fi

export NODE_EXTRA_CA_CERTS="$REPO_DIR/certificates/rootCA.pem"

# Bundles left by an earlier run satisfy waitForBundles.js on sight, which would
# pass a build that never ran. Clear them so the wait tests this build. The
# bundles are no longer mode-specific -- dist/ is built the same way either way
# -- but a stale one is still indistinguishable from a fresh one.
function clear_bundles {
	rm -rf "$REPO_DIR/dist" "$REPO_DIR/dist-firebase"
}

# Hosting uploads only ever publish dist-firebase, so only the cloud door wants
# the watcher. launch_interface.sh clears the flag when the CLI cannot deploy; a
# daemon launch never sets it and so defaults to on, which is what a dashboard
# claim has always done.
#
# Started after the bundles exist rather than before, so the watcher never
# surveys a directory clear_bundles has just emptied.
function start_hosting_autodeploy {
	if [ "${WEB_TELEOP_AUTODEPLOY:-1}" = 0 ]; then
		echo "Hosting preview autodeploy disabled."
		return 0
	fi
	echo "Start hosting preview autodeploy..."
	cd "$REPO_DIR" && pm2 start -s --update-env scripts/firebase_hosting_autodeploy.js --name="firebase_hosting_autodeploy" &>>$REDIRECT_LOGFILE || return 1
}

# Build the bundles this mode calls for and wait for them to land.
#
# The LAN bundle is built in both modes: it is what /local/operator/ serves, and
# it is the door that keeps working when the cloud does not. The cloud bundle is
# built only when the cloud door was asked for.
#
# HOSTING_MODE is what server.js and start_robot_browser.js read to decide
# what / serves and which signaling the robot page joins, so it is exported here
# beside the build that produces the matching bundle.
#
# Args:
#   $1: hosting mode: local or firebase.
#
# Returns 0 once every bundle the mode needs exists, 1 on a failed build or a
# wait that timed out. set -e does not apply inside a function the caller tests,
# so every step reports for itself.
function build_and_wait_bundles {
	local mode="$1"

	export HOSTING_MODE="$mode"
	if [ "$mode" = "firebase" ]; then
		echo "Firebase teleop: cloud door at /operator/, LAN door at /local/operator/."
	else
		echo "Local teleop: LAN door at /local/operator/."
	fi

	clear_bundles

	if [ "$BUILD_MODE" = "development" ]; then
		echo "Start local webpack watcher..."
		cd "$REPO_DIR" && pm2 start -s --update-env npm --name="stretch4_web_teleop_local" -- run localstorage &>>$REDIRECT_LOGFILE || return 1
		if [ "$mode" = "firebase" ]; then
			echo "Start Firebase webpack watcher..."
			cd "$REPO_DIR" && pm2 start -s --update-env npm --name="stretch4_web_teleop_firebase" -- run firebase &>>$REDIRECT_LOGFILE || return 1
		fi
	else
		echo "Build local production bundle..."
		cd "$REPO_DIR" && npm run build:localstorage &>>$REDIRECT_LOGFILE || return 1
		if [ "$mode" = "firebase" ]; then
			echo "Build Firebase production bundle..."
			cd "$REPO_DIR" && npm run build:firebase &>>$REDIRECT_LOGFILE || return 1
		fi
	fi

	# Local mode serves dist/ at both / and /local/, so it needs the whole set.
	# Firebase mode takes /robot/ and /operator/ from dist-firebase and wants
	# only the operator entry out of dist/.
	if [ "$mode" = "firebase" ]; then
		node "$REPO_DIR/scripts/waitForBundles.js" \
			dist/operator/index.html \
			dist-firebase/index.html \
			dist-firebase/operator/index.html \
			dist-firebase/robot/index.html || return 1
	else
		node "$REPO_DIR/scripts/waitForBundles.js" \
			dist/index.html \
			dist/operator/index.html \
			dist/robot/index.html || return 1
	fi
}

# Private to this script. Tears down whatever a failed build left behind: the
# pm2 processes it started, the autodeploy watcher if it got that far, and the
# bundles themselves.
function stop_cloud_mode {
	local proc
	for proc in firebase_hosting_autodeploy stretch4_web_teleop stretch4_web_teleop_firebase stretch4_web_teleop_local; do
		pm2 delete "$proc" &>>$REDIRECT_LOGFILE || true
	done
	if [ -n "$REPO_DIR" ]; then
		clear_bundles
	fi
}

# Neither mode degrades into the other. A launch that asked for the cloud door
# and could not build it exits non-zero rather than quietly serving the LAN door
# alone -- which is how launch_interface.sh learns to package the logs, and how
# stretch_firebase_daemon.js learns the launch failed.
if ! build_and_wait_bundles "$HOSTING_MODE"; then
	stop_cloud_mode
	echo "Bundle build failed for --hosting $HOSTING_MODE."
	echo "--hosting $HOSTING_MODE (failed)" &>>$REDIRECT_LOGFILE
	exit 1
fi

if [ "$HOSTING_MODE" = "firebase" ]; then
	start_hosting_autodeploy || exit 1
fi

echo "Start local server..."
cd "$REPO_DIR" && pm2 start -s --update-env server.js &>>$REDIRECT_LOGFILE

echo "Start robot browser..."
cd "$REPO_DIR" && pm2 start -s --update-env start_robot_browser.js &>>$REDIRECT_LOGFILE
