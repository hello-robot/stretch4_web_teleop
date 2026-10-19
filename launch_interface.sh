#!/bin/bash
set -o pipefail

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"
source "$REPO_DIR/scripts/lib/hosting_gate.sh"

# Before validate_installation, which names certificate files after the fleet
# id. Without this it reads whatever the invoking shell happened to export.
teleop_setup_env

FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)" || exit 1
export FEATURE_VOICE_CONTROL_INTERFACE

MAP=""
MODE_OPT=""
FORCE_FIREBASE=0
FORCE_LOCAL=0

usage() {
	cat <<'USAGE'
Usage: ./launch_interface.sh [options]

Launch web teleop on this robot.

Options:
  --hosting <mode>  Which host serves the operator interface. The robot's own
                    server runs either way; this picks where an operator
                    fetches the interface from, and with it the signaling
                    transport.
                      local     the robot's Express server, over Tailscale or WiFi
                      firebase  Firebase Hosting, through your own dashboard
                      dual      both hosts at once
                    Naming a mode makes it a requirement, so the launch reports
                    any host it cannot bring up. Given no mode, both are served
                    when available and a Firebase that was never set up passes
                    without comment.
  -f                Firebase only. Shorthand for --hosting firebase.
  -L                Local only. Wins over every other source.
  -m <map.yaml>     Map to load. Ignored when the file does not exist.
  -h, --help        Show this message.
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
	--hosting)
		shift
		if [ $# -eq 0 ]; then
			echo -e "${RED}ERROR:${NC} --hosting needs local, firebase, or dual."
			exit 1
		fi
		MODE_OPT="$1"
		;;
	--hosting=*) MODE_OPT="${1#--hosting=}" ;;
	-f) FORCE_FIREBASE=1 ;;
	-L) FORCE_LOCAL=1 ;;
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

# Map a named hosting mode onto the intent it expresses. A mode someone names
# is asserted, so dual becomes ARG_DUAL rather than ARG_DEFAULT: it reports a
# half that failed instead of passing over it.
function intent_for_mode {
	case "$1" in
	local) echo ARG_LOCAL ;;
	firebase) echo ARG_FIREBASE ;;
	dual) echo ARG_DUAL ;;
	esac
}

# What was asked for, and with it what counts as a failure worth reporting.
#
#   ARG_DEFAULT   both transports if available; silent when Firebase was never
#                 set up, since nothing is broken and the operator may never
#                 have wanted it
#   ARG_DUAL      both; proceeds on one, but names the half that broke
#   ARG_LOCAL     local alone; its failure is fatal
#   ARG_FIREBASE  firebase alone; its failure is fatal
#
# Precedence, lowest first: default, WEB_TELEOP_HOSTING, -f, --hosting, -L.
LAUNCH_INTENT="ARG_DEFAULT"
INTENT_REASON="default"

MODE_SETTING="$(hosting_mode_setting)" || exit 1
if [ -n "$MODE_SETTING" ]; then
	LAUNCH_INTENT="$(intent_for_mode "$MODE_SETTING")"
	INTENT_REASON="WEB_TELEOP_HOSTING"
fi
if [ "$FORCE_FIREBASE" = 1 ]; then
	LAUNCH_INTENT="ARG_FIREBASE"
	INTENT_REASON="-f"
fi
if [ -n "$MODE_OPT" ]; then
	case "$MODE_OPT" in
	local | firebase | dual) ;;
	*)
		echo -e "${RED}ERROR:${NC} --hosting must be local, firebase, or dual (got '$MODE_OPT')."
		exit 1
		;;
	esac
	LAUNCH_INTENT="$(intent_for_mode "$MODE_OPT")"
	INTENT_REASON="--hosting"
fi
if [ "$FORCE_LOCAL" = 1 ]; then
	LAUNCH_INTENT="ARG_LOCAL"
	INTENT_REASON="-L"
fi

export WEB_TELEOP_AUTODEPLOY=1

want_local=0
want_firebase=0
case "$LAUNCH_INTENT" in
ARG_DEFAULT | ARG_DUAL) want_local=1 want_firebase=1 ;;
ARG_LOCAL) want_local=1 ;;
ARG_FIREBASE) want_firebase=1 ;;
esac

# Captured rather than printed. ARG_DEFAULT has to be able to stay quiet about
# a transport nobody asked for, which it cannot do if the checks write straight
# to the terminal.
local_ok=1
local_error=""
if [ "$want_local" = 1 ]; then
	local_error="$(local_preflight 2>&1)" || local_ok=0
fi

# 0 ready, 2 never set up for Firebase, 3 set up and broken.
firebase_ok=1
firebase_status=0
firebase_error=""
if [ "$want_firebase" = 1 ]; then
	firebase_error="$(firebase_signaling_preflight 2>&1)"
	firebase_status=$?
	[ "$firebase_status" -ne 0 ] && firebase_ok=0
fi

case "$LAUNCH_INTENT" in
ARG_DEFAULT)
	# A robot with no Firebase credentials was never set up for Firebase.
	# Calling that broken would puzzle an operator who has never touched it and
	# does not want to. A robot that WAS set up and has stopped working is worth
	# saying out loud, even to someone who only asked for a plain launch.
	if [ "$firebase_status" -eq 3 ]; then
		echo -e "${RED}WARNING:${NC} Firebase is set up on this robot but not working."
		echo "$firebase_error"
		echo "       Continuing with local hosting."
	fi
	if [ "$local_ok" = 0 ] && [ "$firebase_ok" = 0 ]; then
		echo -e "${RED}ERROR:${NC} no hosting is available."
		echo "$local_error"
		if [ "$firebase_status" -eq 2 ]; then
			echo "       Firebase is not set up on this robot, so there is no fallback."
		fi
		exit 1
	fi
	;;
ARG_DUAL)
	if [ "$local_ok" = 0 ]; then
		echo -e "${RED}WARNING:${NC} local hosting is unavailable."
		echo "$local_error"
	fi
	if [ "$firebase_ok" = 0 ]; then
		echo -e "${RED}WARNING:${NC} Firebase hosting is unavailable."
		echo "$firebase_error"
	fi
	if [ "$local_ok" = 0 ] && [ "$firebase_ok" = 0 ]; then
		echo -e "${RED}ERROR:${NC} dual asked for both hosts; neither is available."
		exit 1
	fi
	;;
ARG_LOCAL)
	if [ "$local_ok" = 0 ]; then
		echo -e "${RED}ERROR:${NC} local hosting is unavailable."
		echo "$local_error"
		exit 1
	fi
	;;
ARG_FIREBASE)
	if [ "$firebase_ok" = 0 ]; then
		echo -e "${RED}ERROR:${NC} Firebase hosting is unavailable."
		echo "$firebase_error"
		exit 1
	fi
	;;
esac

# The spine speaks hosting modes, not intents. Collapse to what came up.
started_local=$((want_local && local_ok))
started_firebase=$((want_firebase && firebase_ok))
if [ "$started_local" = 1 ] && [ "$started_firebase" = 1 ]; then
	HOSTING_MODE="dual"
elif [ "$started_firebase" = 1 ]; then
	HOSTING_MODE="firebase"
else
	HOSTING_MODE="local"
fi

if [ "$HOSTING_MODE" != "local" ]; then
	# Hosting uploads are a convenience. Losing them costs preview deploys of
	# this checkout and nothing else, so they never veto the launch.
	if ! firebase_hosting_preflight; then
		echo "       Continuing without Hosting preview autodeploy."
		export WEB_TELEOP_AUTODEPLOY=0
	fi
	firebase_warn_if_daemon_down
fi

echo -e "${BLUE}Hosting mode:${NC} $HOSTING_MODE ($INTENT_REASON)"

logdir="$(teleop_log_dir)"
logzip="$logdir/stretch4_web_teleop_logs.zip"

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

# Validate web teleop installation
# Shared installation sanity, required by every hosting mode. The
# certificates the local HTTPS server needs are checked by local_preflight
# instead, so a robot with broken certificates can still serve through
# Firebase Hosting.
function validate_installation {
	local env_file="$HOME/ament_ws/src/stretch4_web_teleop/.env"

	echo -e "Validating web teleop installation..."

	# Check .env file exists
	if [ ! -f "$env_file" ]; then
		echo -e "${RED}ERROR:${NC} .env file not found at $env_file"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check node_modules folder exists
	local node_modules_dir="$HOME/ament_ws/src/stretch4_web_teleop/node_modules"
	if [ ! -d "$node_modules_dir" ]; then
		echo -e "${RED}ERROR:${NC} node_modules folder not found at $node_modules_dir"
		echo "       Run 'npm install --force' to install dependencies OR update your ROS workspace https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check npm dependencies have no errors
	cd "$HOME/ament_ws/src/stretch4_web_teleop"
	npm list --depth=0 >/dev/null 2>&1
	if [ $? -ne 0 ]; then
		echo -e "${RED}ERROR:${NC} npm dependencies have errors. "
		echo "       Run 'npm install --force' to fix OR update your ROS workspace https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	echo -e "${GREEN}✓ Installation validation passed${NC}"
	return 0
}

function echo_failure_help {
	zip -r $logzip $logdir/ >/dev/null
	echo ""
	echo "#############################################"
	echo -e "${RED}FAILURE. COULD NOT LAUNCH WEB TELEOP.${NC}"
	echo "Look at the troubleshooting guide for solutions to common issues: https://docs.hello-robot.com/0.3/getting_started/demos_web_teleop/#troubleshooting"
	echo "or contact Hello Robot support and include $logzip"
	echo "#############################################"
	echo ""
	exit 1
}

function print_interface_urls {
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
	      print "Tailscale: https://" ip "/operator"
	    } else if (iface ~ /^(wlan|wl)/) {
	      print "WiFi: https://" ip "/operator"
	    } else if (iface ~ /^(eth|en)/) {
	      print "Ethernet: https://" ip "/operator"
	    } else {
	      print iface ": https://" ip "/operator"
	    }
	  }'
}

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

validate_installation
if [ $? -ne 0 ]; then
	echo_failure_help
fi

# The spine brings up ROS and the web server. The daemon reaches the same code
# through launch_interface_firebase.sh, so neither path has its own copy.
cd "$REPO_DIR"
./launch_teleop_stack.sh --hosting "$HOSTING_MODE" -l "$logdir" $MAP
if [ $? -ne 0 ]; then
	echo_failure_help
fi

# Dual mode downgrades itself when the Firebase half of the build fails, so the
# URLs below report the mode that actually started, not the one that was asked
# for.
if [ -f "$logdir/hosting_mode" ]; then
	STARTED_MODE="$(cat "$logdir/hosting_mode")"
	if [ "$STARTED_MODE" != "$HOSTING_MODE" ]; then
		echo -e "${RED}WARNING:${NC} Firebase setup failed during startup. Started $STARTED_MODE instead."
		HOSTING_MODE="$STARTED_MODE"
	fi
fi

zip -r $logzip $logdir/ >/dev/null

echo ""
echo "#############################################"
echo -e "${GREEN}DONE! WEB TELEOP IS UP!${NC}"
echo "Visit the appropriate URL(s) below to see web teleop:"
if [ "$HOSTING_MODE" != "local" ]; then
	PROJECT_ID="$(teleop_env_val PUBLIC_FIREBASE_PROJECT_ID)"
	if [ -n "$PROJECT_ID" ]; then
		echo "Dashboard: https://${PROJECT_ID}.web.app/"
	fi
fi
if [ "$HOSTING_MODE" = "firebase" ]; then
	# The local server still answers, but it is serving the Firebase bundle,
	# which signs in to the cloud rather than connecting over the LAN.
	echo "(Firebase-only: this robot is not reachable over Tailscale or WiFi.)"
else
	echo "Localhost: https://localhost/operator"
	print_interface_urls
fi
echo "#############################################"
echo ""
