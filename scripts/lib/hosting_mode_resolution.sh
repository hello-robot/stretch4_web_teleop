# shellcheck shell=bash
# Firebase readiness, and the standing hosting mode setting.
#
# Source this; do not execute it. The check sets shell variables the caller
# evaluates, and exports WEB_TELEOP_AUTODEPLOY, neither of which a subprocess
# could hand back. Sources teleop_config.sh for .env access and
# validate_installation.
#
# There is no local counterpart. Everything the robot's own server needs --
# the certificates included -- is checked by validate_installation, which every
# hosting mode requires, so local hosting has no precondition of its own.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/teleop_config.sh"

TELEOP_DAEMON_SERVICE="stretch-web-teleop-daemon.service"

# Readiness status codes, which are checkFirebaseRobotAccess.js's own exit
# codes. The probe separates a robot that was never set up for Firebase from one
# that was and has stopped working; both are fatal to --firebase and differ only
# in what the error says.
STATUS_READY=0
STATUS_NOT_CONFIGURED=2
STATUS_BROKEN=3

# Read a standing hosting mode out of WEB_TELEOP_HOSTING, the way
# WEB_TELEOP_BUILD_MODE is read. The process environment wins over .env, which is
# also the only way to override a standing setting for a single run, since
# --firebase is additive and has no negating flag:
#
#   WEB_TELEOP_HOSTING=local ./launch_interface.sh
#
# Echoes local or firebase, or nothing when unset. Returns non-zero on a value
# that is set but unrecognized -- dual among them, which is no longer a mode --
# rather than falling through to a default the operator did not ask for.
function hosting_mode_setting {
	local raw
	raw="${WEB_TELEOP_HOSTING:-$(teleop_env_val WEB_TELEOP_HOSTING)}"
	[ -z "$raw" ] && return 0
	case "$raw" in
	local | firebase) echo "$raw" ;;
	dual)
		echo "WEB_TELEOP_HOSTING=dual is no longer a mode. Use firebase: it serves" >&2
		echo "the cloud door and the LAN door, and the operator picks one by URL." >&2
		return 1
		;;
	*)
		echo "WEB_TELEOP_HOSTING must be local or firebase (got '$raw')." >&2
		return 1
		;;
	esac
}

# Whether Firebase can serve this robot right now.
#
# Two credentials, two capabilities. The client SDK signs in as ROBOT_USERNAME
# to reach signaling; the Firebase CLI holds a separate credential that only
# uploads Hosting. Only the first can stop teleop from working, so only the
# first decides fb_status. The second runs after it passes and, failing, clears
# WEB_TELEOP_AUTODEPLOY instead of vetoing -- a robot can serve through Firebase
# Hosting with preview uploads switched off.
#
# Sets fb_status to STATUS_READY, STATUS_NOT_CONFIGURED or STATUS_BROKEN, and
# firebase_error to the probe's reason when it is not ready. The probe's output
# is captured rather than printed so the caller can frame it: 2 and 3 are both
# fatal to --firebase but want different advice. The Hosting and daemon warnings
# below it are advisory and always print, since by then signaling is known to
# work and the cloud door will open.
#
# Never reached by a launch that named no mode: local is the default, so a bare
# launch asks Firebase nothing.
function check_firebase_readiness {
	local probe_output probe_status

	echo -e "Checking Firebase hosting readiness..."

	probe_output="$(node "$TELEOP_REPO_DIR/scripts/checkFirebaseRobotAccess.js" 2>&1)"
	probe_status=$?
	if [ "$probe_status" -ne "$STATUS_READY" ]; then
		# Any code other than the probe's own 2 and 3 is node failing to run it
		# at all, which is a robot that is set up and not working.
		if [ "$probe_status" -ne "$STATUS_NOT_CONFIGURED" ]; then
			probe_status=$STATUS_BROKEN
		fi
		fb_status=$probe_status
		firebase_error="$probe_output"
		return
	fi

	fb_status=$STATUS_READY
	firebase_error=""

	if ! check_firebase_host_setup; then
		echo "       Continuing without Hosting preview autodeploy."
		export WEB_TELEOP_AUTODEPLOY=0
	fi
	firebase_warn_if_daemon_down
	echo -e "${GREEN}✓ Firebase hosting check passed${NC}"
}

# projectId is entered once, in .env. The CLI can only read it from .firebaserc,
# so regenerate that before anything shells out to the CLI.
#
# Returns 0 when the CLI holds a credential that can upload Hosting.
function check_firebase_host_setup {
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
