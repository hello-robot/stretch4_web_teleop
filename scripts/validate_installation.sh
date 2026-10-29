#!/bin/bash
# Standalone installation check.
#
# Wraps validate_installation from scripts/lib/teleop_config.sh so it can be run
# on its own, without starting a launch. launch_interface.sh calls the function
# directly, so nothing in the launch path depends on this script -- it exists so
# a person can answer "can this robot serve web teleop?" in one command, and so
# a caller that is not a bash script could ask the same thing.
#
# Worth asking for in a support thread:
#
#   ./scripts/validate_installation.sh; echo $?
#
# Usage: ./scripts/validate_installation.sh
#
# Exits 0 when this robot can serve web teleop, 1 otherwise, printing the
# reason. Checks .env, node_modules, npm dependencies and the SSL certificates.
set -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/scripts/lib/teleop_env.sh"
source "$REPO_DIR/scripts/lib/teleop_config.sh"

# Defines the HELLO_FLEET_ID the certificate filenames are built from.
teleop_setup_env

validate_installation
