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

# 1. Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

# 2. Resolve the repo directory and source the shared libraries
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"
source "$REPO_DIR/scripts/lib/hosting_mode_resolution.sh"

# 3. Export the teleop environment
#
# Before validate_installation, which names certificate files after the fleet
# id. Without this it reads whatever the invoking shell happened to export.
teleop_setup_env

# 4. Initialize configuration defaults
MAP=""
MAP_YAML="<none>"
MAP_YAML_SOURCE="map-less mode"
CLI_HOSTING=""
CLI_HOSTING_FLAG=""
DRY_RUN=0

# 5. Define the usage text
usage() {
	cat <<'USAGE'
Usage: ./launch_interface.sh [options]

Launch web teleop on this robot.

Options:
  --hosting [mode]  Set hosting mode: local (default) or firebase.
  -f, --firebase    Shorthand for --hosting firebase. Serve the operator
                    interface through Firebase Hosting in addition to the LAN
                    door at /local/operator/. Firebase must already be set up
                    on this robot -- the launch reports an error rather than
                    quietly serving local instead.
  --local           Shorthand for --hosting local. Overrides a standing
                    HOSTING_MODE=firebase in .env or the environment.
  -m <map.yaml>     Map to load. Ignored when the file does not exist.
  --dry-run         Validate installation, resolve all configuration and
                    provenance, run preflights, print the manifest, and exit 0
                    without touching ROS2 or pm2.
  -h, --help        Show this message.

Without flags or standing HOSTING_MODE configuration, the launch is local only.

Operator URLs, once the launch finishes:
  https://<host>/local/operator/   the LAN door, over Tailscale or WiFi, in
                                   both modes. Needs no internet.
  https://<host>/operator/         the cloud door in firebase mode; in local
                                   mode it redirects to /local/operator/.
USAGE
}

# 6. Parse arguments
#
# Arguments are parsed before anything else runs: --help and a misspelled flag
# are handled before resolving the npm dependency tree
while [ $# -gt 0 ]; do
	case "$1" in
	-f | --firebase)
		CLI_HOSTING="firebase"
		CLI_HOSTING_FLAG="$1"
		;;
	--local)
		CLI_HOSTING="local"
		CLI_HOSTING_FLAG="--local"
		;;
	--hosting)
		if [ $# -gt 1 ] && [[ "$2" != -* ]]; then
			shift
			CLI_HOSTING="$1"
			CLI_HOSTING_FLAG="--hosting $1"
		else
			CLI_HOSTING="local"
			CLI_HOSTING_FLAG="--hosting (default: local)"
		fi
		;;
	--hosting=*)
		CLI_HOSTING="${1#--hosting=}"
		CLI_HOSTING="${CLI_HOSTING:-local}"
		CLI_HOSTING_FLAG="$1"
		;;
	-m)
		shift
		if [ $# -eq 0 ]; then
			echo -e "${RED}ERROR:${NC} -m needs a path to a map .yaml."
			exit 1
		fi
		if [ -f "$1" ]; then
			MAP="-m $1"
			MAP_YAML="$1"
			MAP_YAML_SOURCE="from cli: -m"
		else
			MAP_YAML="<none>"
			MAP_YAML_SOURCE="cli: -m ($1 not found; map-less mode)"
		fi
		;;
	--dry-run)
		DRY_RUN=1
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

# 7. Resolve the log directory for this run and record where it came from
if [ -n "${WEB_TELEOP_LOG_DIR:-}" ]; then
	export WEB_TELEOP_LOG_DIR_SOURCE="env:WEB_TELEOP_LOG_DIR"
else
	export WEB_TELEOP_LOG_DIR_SOURCE="default"
fi

if [ "$DRY_RUN" -eq 1 ]; then
	RESOLVED_LOG_DIR="${WEB_TELEOP_LOG_DIR:-$TELEOP_LOG_ROOT/stretch4_web_teleop_$(date '+%Y%m%d%H%M')}"
	export RESOLVED_LOG_DIR
else
	logdir="$(teleop_log_dir)"
	export RESOLVED_LOG_DIR="$logdir"
	logzip="$logdir/stretch4_web_teleop_logs.zip"
fi

# 8. Define the operator URL printer
#
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

	echo -e "${BLUE}Hosting Mode:${NC} $HOSTING_MODE ($HOSTING_MODE_SOURCE)"
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

# 9. Print the banner
echo ""
echo "#############################################"
echo -e "${GREEN}STRETCH VOICE CONTROL (SVC)${NC}"
echo "#############################################"
echo ""

# 10. Report the web_teleop log disk usage
#
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

# 11. Print the resolved feature flags
echo "Feature Flags:"
while IFS=$'=\t' read -r var value source; do
	if [[ "$value" -eq 1 ]]; then
		echo -e "  ${GREEN}$var=$value${NC} (from $source)"
	else
		echo -e "  ${RED}$var=$value${NC} (from $source)"
	fi
done < <(node "$REPO_DIR/feature-flags.js" --all --sources)

# 12. Validate the installation
#
# Certificates included, so this gates every mode. It also runs before the
# Firebase probe on purpose: that probe reports a missing node_modules as its
# own "set up and broken" code, which would blame Firebase for a broken install.
if [ "$DRY_RUN" -eq 1 ]; then
	validate_installation || exit 1
else
	validate_installation || echo_failure_help "$logdir"
fi

# 13. Resolve HOSTING_MODE across all layers (default < .env < env < CLI),
#     then autodeploy and build mode.
resolve_hosting_mode "$CLI_HOSTING" "$CLI_HOSTING_FLAG" || exit 1
teleop_resolve_autodeploy
teleop_resolve_build_mode

# 14. Check Firebase readiness when hosting through the cloud
#
# Only HOSTING_MODE=firebase has anything left to check. HOSTING_MODE=local
# needs nothing beyond the installation that was just validated.
fb_status=$STATUS_READY
firebase_error=""
if [ "$HOSTING_MODE" = "firebase" ]; then
	check_firebase_readiness
	if [ "$fb_status" -ne "$STATUS_READY" ]; then
		echo -e "${RED}ERROR${NC} $firebase_error"
		exit 1
	fi
fi

# 15. Print the launch manifest; --dry-run stops here
export MAP_YAML MAP_YAML_SOURCE
if [ "$DRY_RUN" -eq 1 ]; then
	print_launch_manifest
	exit 0
fi

print_launch_manifest "$logdir/launch_manifest.txt"

# 16. Resolve the voice control interface feature flag
FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)" || exit 1
export FEATURE_VOICE_CONTROL_INTERFACE


# 17. Start ROS2
logfile_ros="$logdir/start_ros2.txt"
logfile_node="$logdir/start_web_server_and_robot_browser.txt"

cd "$REPO_DIR"

./start_ros2.sh -l "$logdir" $MAP |& tee "$logfile_ros"

# 18. Configure audio
./configure_audio.sh

# echo ""
# 19. Start the web server and the robot browser
cd "$REPO_DIR"
./start_web_server_and_robot_browser.sh -l "$logdir" -o "$logfile_node" --hosting "$HOSTING_MODE" |& tee -a "$logfile_node"
if [ $? -ne 0 ]; then
	echo_failure_help "$logdir"
fi

# 20. Archive this run's logs and print the operator URLs
zip -r $logzip $logdir/ >/dev/null

print_interface_urls "$HOSTING_MODE"
