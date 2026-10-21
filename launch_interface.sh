#!/bin/bash
# The launch. Decides which doors to open, then opens them.
#
# Both entry points come through here: a person at a terminal, and
# stretch_firebase_daemon.js, which spawns this with -f on a dashboard claim.
# There is one launch path, so a change lands on both callers at once -- the
# daemon pays a redundant Firebase probe for that, which is cheap next to the
# cost of two paths drifting apart.
#
# Usage: ./launch_interface.sh [-f|--firebase] [-m map.yaml]
#
# The log directory comes from WEB_TELEOP_LOG_DIR when set, which is how the
# daemon points a run at a directory it is already tailing.
set -o pipefail

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"
source "$REPO_DIR/scripts/lib/hosting_mode_resolution.sh"

# Before validate_installation, which names certificate files after the fleet
# id. Without this it reads whatever the invoking shell happened to export.
teleop_setup_env

FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)" || exit 1
export FEATURE_VOICE_CONTROL_INTERFACE

MAP=""
WANT_FIREBASE=0

usage() {
	cat <<'USAGE'
Usage: ./launch_interface.sh [options]

Launch web teleop on this robot.

Options:
  -f, --firebase    Also serve the operator interface through Firebase Hosting,
                    so an operator can reach this robot from your own dashboard.
                    The robot's own server runs either way, and the LAN door at
                    /local/operator/ is served in both cases; this adds the
                    cloud door. Firebase must already be set up on this robot --
                    the launch reports an error rather than quietly serving
                    local instead.
  -m <map.yaml>     Map to load. Ignored when the file does not exist.
  -h, --help        Show this message.

Without -f the launch is local only, which is the default.

To override a standing WEB_TELEOP_HOSTING=firebase for a single run, set it in
the environment instead -- there is no negating flag:

  WEB_TELEOP_HOSTING=local ./launch_interface.sh

Operator URLs, once the launch finishes:
  https://<host>/local/operator/   the LAN door, over Tailscale or WiFi, in
                                   both modes. Needs no internet.
  https://<host>/operator/         the cloud door with -f; in local mode it
                                   redirects to /local/operator/.
USAGE
}

# Arguments are parsed before anything else runs: --help and a misspelled flag
# are answers this script can give without an npm dependency tree, and a broken
# checkout is no reason to withhold its own usage text.
while [ $# -gt 0 ]; do
	case "$1" in
	-f | --firebase) WANT_FIREBASE=1 ;;
	-m)
		shift
		if [ $# -eq 0 ]; then
			echo -e "${RED}ERROR:${NC} -m needs a path to a map .yaml."
			exit 1
		fi
		if [ -f "$1" ]; then
			MAP="-m $1"
		fi
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo -e "${RED}ERROR:${NC} unknown option: $1"
		usage >&2
		exit 1
		;;
	esac
	shift
done

logdir="$(teleop_log_dir)"
logzip="$logdir/stretch4_web_teleop_logs.zip"

# Print the URLs an operator should visit for the mode that started.
#
# Both doors are named in both modes, because the point of the split is that a
# URL means one thing: /local/operator/ is always the LAN bundle over socket.io,
# and /operator/ is always the cloud bundle -- a redirect to the former when no
# cloud door was opened.
#
# Args:
#   $1: hosting mode: local or firebase.
function print_interface_urls {
	local mode="$1"
	local project_id

	echo ""
	echo "#############################################"
	echo -e "${GREEN}DONE! WEB TELEOP IS UP!${NC}"
	echo ""

	echo -e "${BLUE}Hosting Mode:${NC} $HOSTING_MODE ($INTENT_REASON)"
	echo "  Robot: https://localhost/local/operator/"
	if [ "$mode" = "firebase" ]; then
		project_id="$(teleop_env_val PUBLIC_FIREBASE_PROJECT_ID)"
		if [ -n "$project_id" ]; then
			echo "  Dashboard: https://${project_id}.web.app/"
		fi
	fi
	ifconfig | awk '
	  /^[^ \t]/ {
	    iface=$1
	    sub(/:$/, "", iface)
	    next
	  }
	  /inet / {
	    ip=""
	    for (i=1; i<=NF; i++) {
	      if ($i ~ /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/) {
	        ip=$i
	        break
	      }
	    }
	    if (ip == "" || ip == "127.0.0.1") next

	    if (iface == "tailscale0") {
	      print "  Tailscale: https://" ip "/local/operator/"
	    } else if (iface ~ /^(wlan|wl)/) {
	      print "  WiFi: https://" ip "/local/operator/"
	    } else if (iface ~ /^(eth|en)/) {
	      print "  Ethernet: https://" ip "/local/operator/"
	    } else {
	      print "  " iface ": https://" ip "/local/operator/"
	    }
	  }'

	echo "#############################################"
	echo ""
}

echo ""
echo "#############################################"
echo -e "${GREEN}STRETCH VOICE CONTROL (SVC)${NC}"
echo "#############################################"
echo ""

# Voice JSONL logs and audio-snippet clips (when voice_input_recording is
# enabled) are written under this run's own timestamped $logdir — see
# voiceInteractionLogger.js's getLogDir/getVoiceAudioDir. Nothing accumulates
# in a separate persistent directory across runs, so there is no pre-run disk
# usage to report here.
web_teleop_du=$(du -sh "$HOME/stretch_user/log/web_teleop" 2>/dev/null | awk '{print $1}')
echo -e "${BLUE}web_teleop logs total size:${NC} ${web_teleop_du:-0} in $HOME/stretch_user/log/web_teleop (not auto-purged; purge old run folders manually if desired)"

echo ""
echo "#############################################"
echo "LAUNCHING WEB TELEOP"
echo "#############################################"

echo "Feature Flags:"
while IFS='=' read -r var value; do
	if [[ "$value" -eq 1 ]]; then
		echo -e "  ${GREEN}$var=$value${NC}"
	else
		echo -e "  ${RED}$var=$value${NC}"
	fi
done < <(node "$REPO_DIR/feature-flags.js" --all)

# Certificates included, so this gates every mode. It also runs before the
# Firebase probe on purpose: that probe reports a missing node_modules as its
# own "set up and broken" code, which would blame Firebase for a broken install.
validate_installation || echo_failure_help "$logdir"

# What was asked for, and with it what counts as a failure worth reporting.
#
#   ARG_LOCAL     the robot's own server alone. What a launch that names
#                 nothing gets, so a bare launch never probes Firebase.
#   ARG_FIREBASE  the cloud door as well as the LAN one. Firebase failing is
#                 fatal: there is no downgrade to local.
#
# Precedence, lowest first: default, WEB_TELEOP_HOSTING, -f/--firebase. The flag
# is additive, so overriding a standing setting is done from the environment.
LAUNCH_INTENT="ARG_LOCAL"
INTENT_REASON="default"

MODE_SETTING="$(hosting_mode_setting)" || exit 1
case "$MODE_SETTING" in
local)
	LAUNCH_INTENT="ARG_LOCAL"
	INTENT_REASON="WEB_TELEOP_HOSTING"
	;;
firebase)
	LAUNCH_INTENT="ARG_FIREBASE"
	INTENT_REASON="WEB_TELEOP_HOSTING"
	;;
esac
if [ "$WANT_FIREBASE" = 1 ]; then
	LAUNCH_INTENT="ARG_FIREBASE"
	INTENT_REASON="--firebase"
fi

export WEB_TELEOP_AUTODEPLOY=1

# Only ARG_FIREBASE has anything left to check. ARG_LOCAL needs nothing beyond
# the installation that was just validated.
fb_status=$STATUS_READY
firebase_error=""
if [ "$LAUNCH_INTENT" = "ARG_FIREBASE" ]; then
	check_firebase_readiness
fi

# Lock HOSTING_MODE. Past this point it is the single source of truth: nothing
# downstream re-decides it and nothing upstream is consulted again.
if [ "$LAUNCH_INTENT" = "ARG_FIREBASE" ]; then
	if [ "$fb_status" -ne "$STATUS_READY" ]; then
		echo -e "${RED}ERROR:${NC} Firebase hosting was asked for and is unavailable."
		echo "$firebase_error"
		if [ "$fb_status" -eq "$STATUS_NOT_CONFIGURED" ]; then
			echo "       This robot is not set up for Firebase. Run ./onboard_firebase_robot.sh"
		fi
		echo "       Relaunch without -f to serve the LAN door alone."
		exit 1
	fi
	HOSTING_MODE="firebase"
else
	HOSTING_MODE="local"
fi


# Bring up ROS, then the web server and robot browser. These were a separate
# launch_teleop_stack.sh for as long as a second front door called it; with the
# daemon coming through this script too, a spine with one caller was indirection
# for its own sake.
teleop_resolve_build_mode
logfile_ros="$logdir/start_ros2.txt"
logfile_node="$logdir/start_web_server_and_robot_browser.txt"

cd "$REPO_DIR"
# set -o pipefail is what makes these statuses the scripts' and not tee's.
./start_ros2.sh -l "$logdir" $MAP |& tee "$logfile_ros"
if [ $? -ne 0 ]; then
	echo_failure_help "$logdir"
fi

./start_web_server_and_robot_browser.sh -l "$logdir" -o "$logfile_node" --hosting "$HOSTING_MODE" |& tee -a "$logfile_node"
if [ $? -ne 0 ]; then
	echo_failure_help "$logdir"
fi

zip -r $logzip $logdir/ >/dev/null

print_interface_urls "$HOSTING_MODE"
