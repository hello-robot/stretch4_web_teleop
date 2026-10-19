# shellcheck shell=bash
# Hosting preconditions for both transports.
#
# Source this; do not execute it. Sources teleop_config.sh for .env access.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/teleop_config.sh"

TELEOP_DAEMON_SERVICE="stretch-web-teleop-daemon.service"

# Read a standing hosting mode out of WEB_TELEOP_HOSTING, the way
# WEB_TELEOP_BUILD_MODE is read. The process environment wins over .env so one
# launch can be overridden without editing the file.
#
# Echoes local, firebase, or dual, or nothing when unset. Returns non-zero on
# a value that is set but unrecognized, rather than falling through to a
# default the operator did not ask for.
function hosting_mode_setting {
	local raw
	raw="${WEB_TELEOP_HOSTING:-$(teleop_env_val WEB_TELEOP_HOSTING)}"
	[ -z "$raw" ] && return 0
	case "$raw" in
	local | firebase | dual) echo "$raw" ;;
	*)
		echo "WEB_TELEOP_HOSTING must be local, firebase, or dual (got '$raw')." >&2
		return 1
		;;
	esac
}

# Whether the robot's own HTTPS server can serve the operator interface.
#
# Only the certificates are local-specific; everything else a local build
# needs is checked by validate_installation, which every mode requires. A
# robot with broken certificates can still serve through Firebase Hosting, so
# this is a gate on the local transport alone and not on the launch.
#
# Prints the reason on failure. Returns 0 when local hosting can serve.
function local_preflight {
	local cert_dir="$TELEOP_REPO_DIR/certificates"
	local certfile_name="${HELLO_FLEET_ID}+6.pem"
	local keyfile_name="${HELLO_FLEET_ID}+6-key.pem"
	local hint="       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"

	if [ ! -d "$cert_dir" ]; then
		echo "Certificates folder not found at $cert_dir"
		echo "$hint"
		return 1
	fi
	if [ ! -f "$cert_dir/$certfile_name" ]; then
		echo "Certificate file not found at $cert_dir/$certfile_name"
		echo "$hint"
		return 1
	fi
	if [ ! -f "$cert_dir/$keyfile_name" ]; then
		echo "Key file not found at $cert_dir/$keyfile_name"
		echo "$hint"
		return 1
	fi

	local env_certfile env_keyfile
	env_certfile="$(teleop_env_val certfile)"
	env_keyfile="$(teleop_env_val keyfile)"
	if [ "$env_certfile" != "$certfile_name" ]; then
		echo ".env certfile is set to '$env_certfile' but should be '$certfile_name'"
		echo "$hint"
		return 1
	fi
	if [ "$env_keyfile" != "$keyfile_name" ]; then
		echo ".env keyfile is set to '$env_keyfile' but should be '$keyfile_name'"
		echo "$hint"
		return 1
	fi
}

# Whether Firebase signaling can work on this robot right now.
#
# Two credentials, two capabilities. The client SDK signs in as ROBOT_USERNAME
# to reach signaling; the Firebase CLI holds a separate credential that only
# uploads Hosting. Only the first can stop teleop from working, so only the
# first is allowed to veto a cloud mode.
#
# Prints the reason on failure. Returns the probe's own exit code: 0 ready,
# 2 never set up for Firebase, 3 set up and broken.
function firebase_signaling_preflight {
	node "$TELEOP_REPO_DIR/scripts/checkFirebaseRobotAccess.js"
}

# projectId is entered once, in .env. The CLI can only read it from .firebaserc,
# so regenerate that before anything shells out to the CLI.
function firebase_hosting_preflight {
	local firebase_bin="$TELEOP_REPO_DIR/node_modules/.bin/firebase"
	if [ ! -x "$firebase_bin" ]; then
		echo -e "${RED}WARNING:${NC} Firebase CLI not found at $firebase_bin"
		echo "       Run 'npm install --force' to install dependencies."
		return 1
	fi
	# A CI token authenticates non-interactively, with no account logged in.
	if [ -z "$FIREBASE_TOKEN" ]; then
		local accounts status
		accounts="$(timeout 30 "$firebase_bin" login:list 2>&1)"
		status=$?
		if [ $status -ne 0 ] || echo "$accounts" | grep -qi "no authorized accounts"; then
			echo -e "${RED}WARNING:${NC} Firebase CLI has no logged-in account."
			echo "       Run 'npx firebase login', or set FIREBASE_TOKEN."
			return 1
		fi
	fi
	node "$TELEOP_REPO_DIR/scripts/syncFirebaseRc.js" || return 1
}

# Warn when the daemon is down. It is what lets a Firebase dashboard launch
# and stop this robot; teleop through Firebase works without it, so this
# never vetoes.
function firebase_warn_if_daemon_down {
	if systemctl is-active --quiet "$TELEOP_DAEMON_SERVICE" 2>/dev/null; then
		return 0
	fi
	echo -e "${RED}WARNING:${NC} $TELEOP_DAEMON_SERVICE is not running."
	echo "       Your dashboard cannot launch or stop this robot until it is."
	echo "       Start it with: sudo systemctl start $TELEOP_DAEMON_SERVICE"
}
