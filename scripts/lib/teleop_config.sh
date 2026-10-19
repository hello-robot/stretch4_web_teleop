# shellcheck shell=bash
# Configuration and logging shared by every launch path.
#
# Source this; do not execute it.

TELEOP_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEOP_ENV_FILE="$TELEOP_REPO_DIR/.env"
TELEOP_LOG_ROOT="$HOME/stretch_user/log/web_teleop"

# Defined only when the caller has not already defined them, so a front door
# that sets its own palette keeps it.
: "${RED:=\033[0;31m}"
: "${GREEN:=\033[0;32m}"
: "${BLUE:=\033[0;34m}"
: "${NC:=\033[0m}"

# Read one key out of .env.
#
# Args:
#   $1: key name.
#
# Echoes the value, or nothing when the key or the file is missing.
function teleop_env_val {
	grep -m1 "^$1=" "$TELEOP_ENV_FILE" 2>/dev/null | cut -d= -f2-
}

# Resolve and export WEB_TELEOP_BUILD_MODE. The process environment wins over
# .env so one launch can be overridden without editing the file. Defaults to
# development.
function teleop_resolve_build_mode {
	if [ -z "$WEB_TELEOP_BUILD_MODE" ]; then
		WEB_TELEOP_BUILD_MODE="$(teleop_env_val WEB_TELEOP_BUILD_MODE)"
	fi
	export WEB_TELEOP_BUILD_MODE="${WEB_TELEOP_BUILD_MODE:-development}"
}

# Resolve this run's log directory, create it, and repoint latest_run at it.
#
# The symlink mirrors ROS's own ~/.ros/log/latest convention so tools started
# outside the launch -- the watch-* panes in tools/terminator/config, which
# have no log directory of their own -- tail the current run, not a stale one.
#
# Args:
#   $1: directory to use, or empty to take WEB_TELEOP_LOG_DIR, or a fresh
#       timestamped directory when neither is set.
#
# Echoes the directory.
function teleop_log_dir {
	local dir="${1:-${WEB_TELEOP_LOG_DIR:-}}"
	if [ -z "$dir" ]; then
		dir="$TELEOP_LOG_ROOT/stretch4_web_teleop_$(date '+%Y%m%d%H%M')"
	fi
	mkdir -p "$dir"
	ln -sfn "$dir" "$TELEOP_LOG_ROOT/latest_run"
	echo "$dir"
}
