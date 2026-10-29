#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure ROS 2 environment is sourced if rviz2 is not in PATH
if ! command -v rviz2 &>/dev/null; then
	if [[ -f "/opt/ros/jazzy/setup.bash" ]]; then
		# shellcheck source=/dev/null
		source "/opt/ros/jazzy/setup.bash"
	fi
	# Source workspace install if available relative to repository
	WORKSPACE_INSTALL="$(cd "$SCRIPT_DIR/../../install" 2>/dev/null && pwd)"
	if [[ -n "$WORKSPACE_INSTALL" && -f "$WORKSPACE_INSTALL/setup.bash" ]]; then
		# shellcheck source=/dev/null
		source "$WORKSPACE_INSTALL/setup.bash"
	fi
fi

# Locate the RViz config without hardcoded absolute paths
DEFAULT_CONFIG="$SCRIPT_DIR/rviz/remote_monitor.rviz"
if [[ ! -f "$DEFAULT_CONFIG" ]]; then
	if command -v ros2 &>/dev/null; then
		SHARE_DIR="$(ros2 pkg prefix --share stretch4_web_teleop 2>/dev/null || true)"
		if [[ -n "$SHARE_DIR" && -f "$SHARE_DIR/rviz/remote_monitor.rviz" ]]; then
			DEFAULT_CONFIG="$SHARE_DIR/rviz/remote_monitor.rviz"
		fi
	fi
fi

RVIZ_CONFIG="${1:-$DEFAULT_CONFIG}"

if [[ ! -f "$RVIZ_CONFIG" ]]; then
	echo "[launch_rviz.sh] ERROR: RViz configuration file not found: $RVIZ_CONFIG" >&2
	exit 1
fi

shift || true

echo "[launch_rviz.sh] Launching RViz2 with config: $RVIZ_CONFIG"
exec rviz2 -d "$RVIZ_CONFIG" "$@"
