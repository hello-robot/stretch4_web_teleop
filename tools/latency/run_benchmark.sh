#!/bin/bash
# Bring up a mock robot, the local web server and one robot-side
# implementation, run measure_latency.js against it, and tear it all down.
#
#   tools/latency/run_benchmark.sh python [label]    # start_robot_peer.py (rclpy + aiortc)
#   BASELINE_DIR=<checkout> tools/latency/run_benchmark.sh browser [label]
#                                                    # headless Firefox robot page + rosbridge
#
# The browser implementation was removed from this tree. To measure it, check
# out a commit from before the robot peer (see README.md) and point
# BASELINE_DIR at it; its server.js, dist/ and start_robot_browser.js are used.
#
# Results land in tools/latency/results/<label>.json (label defaults to the
# implementation). Compare two runs with
#   node tools/latency/measure_latency.js --compare results/browser.json results/python.json
#
# Needs: ROS 2 sourced, dist/ built (npm run build:localstorage), ports 443 and
# 9090 free (stop the real interface first), and no other robot peer running.
# Extra arguments after the label go to measure_latency.js.
set -euo pipefail

IMPL="${1:-}"
LABEL="${2:-$IMPL}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_DIR/tools/latency/results}"
WORK_DIR="$(mktemp -d)"
PROBE_LOG="$WORK_DIR/probe.jsonl"
CAMERA_FPS="${CAMERA_FPS:-15}"
mkdir -p "$OUT_DIR"

case "$IMPL" in
browser)
	STACK_DIR="${BASELINE_DIR:?set BASELINE_DIR to a checkout that still has start_robot_browser.js, with dist/ built}"
	ROBOT_PROCS='ms-playwright/firefox|rosbridge_websocket|rosapi_node|start_robot_browser\.js'
	;;
python)
	STACK_DIR="$REPO_DIR"
	ROBOT_PROCS='start_robot_peer\.py'
	;;
*)
	echo "Usage: $0 browser|python [label] [measure_latency.js args...]" >&2
	exit 2
	;;
esac

# The mock robot publishes driver topics and offers driver services. On a robot
# with the real interface up it would mix into the live ROS graph, and the
# operator harness would talk to the live server.js. Refuse rather than do that.
if pgrep -u "$USER" -f "web_interface.launch.py|start_robot_browser.js|start_robot_peer.py" >/dev/null ||
	ss -ltn 2>/dev/null | grep -qE ':(80|443|9090)\s'; then
	echo "A teleop stack (or something on port 80/443/9090) is running. Stop it first (./stop_interface.sh)." >&2
	exit 1
fi
# Keep the mock and the peer in a ROS domain of their own all the same.
export ROS_DOMAIN_ID="${BENCHMARK_ROS_DOMAIN_ID:-87}"

# shellcheck disable=SC1091
set -a && source "$REPO_DIR/.env" && set +a
export HOSTING_MODE=local
export NODE_EXTRA_CA_CERTS="$REPO_DIR/certificates/rootCA.pem"

PIDS=()
start() {
	local name="$1"
	shift
	setsid "$@" >"$WORK_DIR/$name.log" 2>&1 &
	PIDS+=($!)
	echo "started $name (pid $!), log: $WORK_DIR/$name.log"
}
cleanup() {
	for pid in "${PIDS[@]}"; do
		kill -INT -- "-$pid" 2>/dev/null || true
	done
	sleep 3
	for pid in "${PIDS[@]}"; do
		kill -KILL -- "-$pid" 2>/dev/null || true
	done
}
trap cleanup EXIT

cd "$REPO_DIR"
start mock_robot python3 tools/latency/mock_robot.py --probe-log "$PROBE_LOG" --fps "$CAMERA_FPS"
cd "$STACK_DIR"
start server node server.js
if [ "$IMPL" = browser ]; then
	start rosbridge ros2 launch rosbridge_server rosbridge_websocket_launch.xml \
		port:=9090 address:=localhost ssl:=true \
		certfile:="$REPO_DIR/certificates/$certfile" keyfile:="$REPO_DIR/certificates/$keyfile" \
		authenticate:=false call_services_in_new_thread:=true
	sleep 3
	start robot node start_robot_browser.js
else
	start robot "${PYTHON:-python3}" start_robot_peer.py
fi
cd "$REPO_DIR"

status=0
node tools/latency/measure_latency.js --label "$LABEL" --probe-log "$PROBE_LOG" \
	--robot-procs "$ROBOT_PROCS" --out "$OUT_DIR/$LABEL.json" "${@:3}" || status=$?
echo "logs kept in $WORK_DIR"
exit $status
