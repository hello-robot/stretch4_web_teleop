#!/bin/bash
# Daemon-facing entry point.
#
# stretch_firebase_daemon.js names this script, so it stays. All it does now is
# pick the mode and hand off to the shared spine: a daemon launch exists to
# serve a Firebase dashboard, and building the local bundle alongside it buys
# nothing here. Everything else -- teardown, ROS, the web server -- is the
# same code the hand-run launch takes.
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REPO_DIR/scripts/lib/teleop_config.sh"

MAP=""
while getopts m: opt; do
	case $opt in
	m)
		if [[ -n "$OPTARG" ]]; then
			echo "Setting map to: $OPTARG"
			MAP="-m $OPTARG"
		fi
		;;
	esac
done

# The daemon picks the directory so it can tail every file we write there and
# merge them into the log a dashboard shows. Standalone runs pick their own.
logdir="$(teleop_log_dir "${WEB_TELEOP_LOG_DIR:-}")"

echo -e "${BLUE}Launching Web Teleop via Firebase Onboard...${NC}"
echo "Logging to $logdir"

"$REPO_DIR/launch_teleop_stack.sh" --hosting firebase -l "$logdir" $MAP

echo -e "${GREEN}✓ Onboard launch completed successfully!${NC}"
