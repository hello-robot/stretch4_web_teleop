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

# Read one key out of .env, stripping optional export prefix, whitespace, and
# matching outer quotes so Bash lookups match Node's dotenv and readEnvFile.
#
# Args:
#   $1: key name.
#
# Echoes the value, or nothing when the key or the file is missing.
function teleop_env_val {
	sed -nE "/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=/ { s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//; s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/; p; q; }" "$TELEOP_ENV_FILE" 2>/dev/null
}

# Resolve and export WEB_TELEOP_BUILD_MODE and WEB_TELEOP_BUILD_MODE_SOURCE.
# The process environment wins over .env so one launch can be overridden without
# editing the file. Defaults to development.
function teleop_resolve_build_mode {
	if [ -n "${WEB_TELEOP_BUILD_MODE:-}" ]; then
		export WEB_TELEOP_BUILD_MODE_SOURCE="${WEB_TELEOP_BUILD_MODE_SOURCE:-env:WEB_TELEOP_BUILD_MODE}"
	else
		WEB_TELEOP_BUILD_MODE="$(teleop_env_val WEB_TELEOP_BUILD_MODE)"
		if [ -n "$WEB_TELEOP_BUILD_MODE" ]; then
			export WEB_TELEOP_BUILD_MODE_SOURCE=".env"
		else
			WEB_TELEOP_BUILD_MODE="development"
			export WEB_TELEOP_BUILD_MODE_SOURCE="default"
		fi
	fi
	export WEB_TELEOP_BUILD_MODE
}

# Resolve and export WEB_TELEOP_AUTODEPLOY and WEB_TELEOP_AUTODEPLOY_SOURCE.
# Respects caller environment and .env before defaulting to 1.
function teleop_resolve_autodeploy {
	if [ -n "${WEB_TELEOP_AUTODEPLOY:-}" ]; then
		export WEB_TELEOP_AUTODEPLOY_SOURCE="${WEB_TELEOP_AUTODEPLOY_SOURCE:-env:WEB_TELEOP_AUTODEPLOY}"
	else
		WEB_TELEOP_AUTODEPLOY="$(teleop_env_val WEB_TELEOP_AUTODEPLOY)"
		if [ -n "$WEB_TELEOP_AUTODEPLOY" ]; then
			export WEB_TELEOP_AUTODEPLOY_SOURCE=".env"
		else
			WEB_TELEOP_AUTODEPLOY="1"
			export WEB_TELEOP_AUTODEPLOY_SOURCE="default"
		fi
	fi
	export WEB_TELEOP_AUTODEPLOY
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

# Print the resolved launch configuration with provenance, and optionally write
# a plain-text copy to a manifest file inside the run's log directory.
#
# Args:
#   $1: optional path to write the plain-text manifest file.
function print_launch_manifest {
	local manifest_file="${1:-}"
	local manifest_text

	manifest_text="$(
		cat <<EOF
Resolved Launch Configuration:
  HOSTING_MODE          = ${HOSTING_MODE:-local} (from ${HOSTING_MODE_SOURCE:-default})
  WEB_TELEOP_BUILD_MODE = ${WEB_TELEOP_BUILD_MODE:-development} (from ${WEB_TELEOP_BUILD_MODE_SOURCE:-default})
  WEB_TELEOP_AUTODEPLOY = ${WEB_TELEOP_AUTODEPLOY:-1} (from ${WEB_TELEOP_AUTODEPLOY_SOURCE:-default})
  HELLO_FLEET_ID        = ${HELLO_FLEET_ID:-<unset>} (from ${HELLO_FLEET_ID_SOURCE:-unset})
  MAP_YAML              = ${MAP_YAML:-<none>} (${MAP_YAML_SOURCE:-map-less mode})
  WEB_TELEOP_LOG_DIR    = ${RESOLVED_LOG_DIR:-<unset>} (from ${WEB_TELEOP_LOG_DIR_SOURCE:-default})
EOF
	)"

	echo ""
	echo "$manifest_text"
	echo ""

	if [ -n "$manifest_file" ]; then
		{
			echo "$manifest_text"
			echo ""
			echo "Feature Flags:"
			while IFS=$'=\t' read -r var value source; do
				echo "  $var = $value (from $source)"
			done < <(node "$TELEOP_REPO_DIR/feature-flags.js" --all --sources)
		} >"$manifest_file"
	fi
}

# Whether this robot's web teleop installation can serve at all.
#
# The launch calls this before resolving anything, and
# scripts/validate_installation.sh wraps it so it can be run by hand or by a
# caller that is not a bash script. The certificates are checked alongside the
# node dependencies and not as a per-transport concern: server.js reads them
# with fs.readFileSync at module scope, unguarded, so a missing certificate
# means the robot's HTTPS server never starts -- and start_robot_browser.js can
# only load the robot page from loopback, which that same server provides. A
# robot with broken certificates therefore has no teleop in any hosting mode.
#
# Runs before the Firebase probe, because checkFirebaseRobotAccess.js reports a
# missing node_modules as its own "set up and broken" code; probing first would
# report a broken installation as broken Firebase.
#
# About 0.75s, dominated by npm list --depth=0. Needs HELLO_FLEET_ID, so call it
# after teleop_setup_env.
#
# Returns 0 when the installation can serve, 1 otherwise, printing the reason.
function validate_installation {
	local env_file="$TELEOP_REPO_DIR/.env"
	local node_modules_dir="$TELEOP_REPO_DIR/node_modules"
	local cert_dir="$TELEOP_REPO_DIR/certificates"
	local certfile_name="${HELLO_FLEET_ID}+6.pem"
	local keyfile_name="${HELLO_FLEET_ID}+6-key.pem"
	local workspace_hint="       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
	local npm_hint="       Run 'npm install --force' to install dependencies OR update your ROS workspace https://docs.hello-robot.com/0.3/installation/ros_workspace/"
	local env_certfile env_keyfile

	echo -e "Validating web teleop installation..."

	if [ ! -f "$env_file" ]; then
		echo -e "${RED}ERROR:${NC} .env file not found at $env_file"
		echo "$workspace_hint"
		return 1
	fi

	if [ ! -d "$node_modules_dir" ]; then
		echo -e "${RED}ERROR:${NC} node_modules folder not found at $node_modules_dir"
		echo "$npm_hint"
		return 1
	fi

	if ! (cd "$TELEOP_REPO_DIR" && npm list --depth=0 >/dev/null 2>&1); then
		echo -e "${RED}ERROR:${NC} npm dependencies have errors. "
		echo "$npm_hint"
		return 1
	fi

	# The HTTPS server the robot page itself is served from. Fatal in every
	# hosting mode, Firebase included.
	if [ ! -d "$cert_dir" ]; then
		echo -e "${RED}ERROR:${NC} Certificates folder not found at $cert_dir"
		echo "$workspace_hint"
		return 1
	fi
	if [ ! -f "$cert_dir/$certfile_name" ]; then
		echo -e "${RED}ERROR:${NC} Certificate file not found at $cert_dir/$certfile_name"
		echo "$workspace_hint"
		return 1
	fi
	if [ ! -f "$cert_dir/$keyfile_name" ]; then
		echo -e "${RED}ERROR:${NC} Key file not found at $cert_dir/$keyfile_name"
		echo "$workspace_hint"
		return 1
	fi
	env_certfile="$(teleop_env_val certfile)"
	env_keyfile="$(teleop_env_val keyfile)"
	if [ "$env_certfile" != "$certfile_name" ]; then
		echo -e "${RED}ERROR:${NC} .env certfile is set to '$env_certfile' but should be '$certfile_name'"
		echo "$workspace_hint"
		return 1
	fi
	if [ "$env_keyfile" != "$keyfile_name" ]; then
		echo -e "${RED}ERROR:${NC} .env keyfile is set to '$env_keyfile' but should be '$keyfile_name'"
		echo "$workspace_hint"
		return 1
	fi

	echo -e "${GREEN}✓ Installation validation passed${NC}"
	return 0
}

# Report a launch that could not come up, package its logs, and exit 1.
#
# Lives here rather than in launch_interface.sh because scripts/lib is where the
# launch's shared pieces are, and a standalone caller may want it too. Called
# when the installation does not validate, and when ROS or the web server fails.
# Since stretch_firebase_daemon.js spawns launch_interface.sh itself, a dashboard
# launch gets the same zip as a hand-run one, and the non-zero exit is what tells
# the daemon the launch failed.
#
# Args:
#   $1: log directory to package. The zip is written inside it.
#
# Never returns.
function echo_failure_help {
	local logdir="$1"
	local logzip="$logdir/stretch4_web_teleop_logs.zip"
	zip -r "$logzip" "$logdir/" >/dev/null 2>&1 || true
	echo ""
	echo "#############################################"
	echo -e "${RED}FAILURE. COULD NOT LAUNCH WEB TELEOP.${NC}"
	echo "Look at the troubleshooting guide for solutions to common issues: https://docs.hello-robot.com/0.3/getting_started/demos_web_teleop/#troubleshooting"
	echo "or contact Hello Robot support and include $logzip"
	echo "#############################################"
	echo ""
	exit 1
}
