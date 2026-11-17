#!/bin/bash
# Which retained rails an origin is actually serving.
#
# A rail confirms itself with the manifest.json it ships with, and nothing on
# the server indexes the rails present, so release.json supplies the names to
# ask about and the origin answers one at a time.
#
# The statuses are the lobby's own (src/pages/home/tsx/useRail.ts): 200 is
# active, 404 and 410 are the origin stating nothing is served there, and
# anything else -- a timeout, a proxy fault, a request that never arrived --
# establishes nothing and is reported as unknown, which is a different claim
# from absent and must not be read as one.
#
# Usage: ./scripts/rail_status.sh [--origin <url>]
#
# The origin falls back to PUBLIC_HOSTING_ORIGIN from the process environment
# and then from .env, the order scripts/deployHosting.js resolves it in.
#
# Exits 0 when every retained rail is active, 1 when any is absent or
# unknown, and 2 when there is no origin to ask.
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/scripts/lib/teleop_config.sh"

origin=""
while [ $# -gt 0 ]; do
	case "$1" in
	--origin)
		origin="${2:-}"
		shift 2 || true
		;;
	--origin=*)
		origin="${1#--origin=}"
		shift
		;;
	*)
		echo "Usage: $0 [--origin <url>]" >&2
		exit 2
		;;
	esac
done

if [ -z "$origin" ]; then
	origin="${PUBLIC_HOSTING_ORIGIN:-$(teleop_env_val PUBLIC_HOSTING_ORIGIN)}"
fi
if [ -z "$origin" ]; then
	echo "No origin: pass --origin or set PUBLIC_HOSTING_ORIGIN." >&2
	exit 2
fi
origin="${origin%/}"

rails="$(node -p '(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rails || []).join("\n")' \
	"$REPO_DIR/release.json")" || exit 1

echo "$origin"
status=0
while read -r rail; do
	[ -n "$rail" ] || continue
	# -s keeps the body off stdout; the code is the whole answer.
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
		-H 'Cache-Control: no-cache' "$origin/r/$rail/manifest.json")"
	case "$code" in
	200)
		state="active"
		;;
	404 | 410)
		state="absent"
		status=1
		;;
	*)
		state="unknown (HTTP $code)"
		status=1
		;;
	esac
	printf '  %-24s %s\n' "$rail" "$state"
done <<<"$rails"

exit "$status"
