#!/bin/bash
set -euo pipefail

RULE_FILE="/etc/sudoers.d/stretch_poweroff"
# Use ALL to allow any user, or %users / %sudo to restrict to a group
RULE_CONTENT="ALL ALL=(root) NOPASSWD: /bin/systemctl poweroff, /usr/bin/systemctl poweroff"

# `sudo -n -l systemctl poweroff` only means the command is allowed. On a
# robot that still needs a password, that check passes and the rule is never
# written. Only a NOPASSWD / !authenticate entry counts.
if sudo -n -ll 2>/dev/null | awk '
	/^Sudoers entry:/ { noauth = 0 }
	/Options:.*!authenticate/ || /NOPASSWD:/ { noauth = 1 }
	noauth && /systemctl poweroff/ { found = 1 }
	END { exit found ? 0 : 1 }
'; then
	echo "Shutdown permissions already configured."
	exit 0
fi

# 2. Write to a temporary file and validate with visudo BEFORE installing
TMP_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE"' EXIT

echo "$RULE_CONTENT" >"$TMP_FILE"
chmod 0440 "$TMP_FILE"

if sudo visudo -cf "$TMP_FILE" >/dev/null; then
	sudo chown root:root "$TMP_FILE"
	sudo mv "$TMP_FILE" "$RULE_FILE"
	echo "Shutdown permissions configured for all users."
else
	echo "Error: Generated sudoers rule failed syntax validation." >&2
	exit 1
fi
