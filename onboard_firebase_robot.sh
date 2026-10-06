#!/bin/bash
# Onboard this robot onto Hello Robot Cloud (Firebase).
# Safe to run again if it is interrupted. Steps that already finished are skipped.
set -euo pipefail

cd "$(dirname "$0")"

FIREBASE="./node_modules/.bin/firebase"

# Which git branch this robot tracks. Set `release` in .env, for example
# release=feature/firebase-sandbox or release=main.
release="$(sed -n 's/^release=//p' .env | head -n 1 | tr -d '\r"')"
if [ -z "$release" ]; then
	echo "ERROR: release is not defined in .env" >&2
	exit 1
fi

# Switch to the branch and grab the latest. Checkout is a no-op when already there.
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" = "$release" ]; then
	echo "Already on ${release}."
else
	echo "Checking out ${release}..."
	git checkout "$release"
fi
git pull --ff-only

# Finish a partial install. A completed node_modules is left as it is.
if [ -x "$FIREBASE" ] && [ -d node_modules/firebase ] && [ -d node_modules/dotenv ]; then
	echo "npm dependencies already installed."
else
	echo "Installing npm dependencies..."
	npm install --legacy-peer-deps
fi

# For the remainder of the script, you will need to be an
# Admin or Owner of the Firebase web app.
if ! "$FIREBASE" login:list 2>/dev/null | grep -q "Logged in as "; then
	echo "Firebase CLI is not logged in."
	echo "Open the URL below on your computer, then paste the code into this terminal."
	"$FIREBASE" login --reauth --no-localhost
fi

# Sign in with the robot account from .env and print the Auth uid.
# roboPassword stays in this process and is not printed.
echo "Signing in as the robot account from .env..."
bind_info="$(
	node <<'EOF'
const path = require("path");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const required = [
	"HELLO_FLEET_ID",
	"projectId",
	"databaseURL",
	"apiKey",
	"authDomain",
	"roboUsername",
	"roboPassword",
];
for (const key of required) {
	if (!process.env[key]) {
		console.error("ERROR: " + key + " is not defined in .env");
		process.exit(1);
	}
}

const app = initializeApp({
	apiKey: process.env.apiKey,
	authDomain: process.env.authDomain,
	databaseURL: process.env.databaseURL,
	projectId: process.env.projectId,
});
const instance = new URL(process.env.databaseURL).hostname.split(".")[0];

signInWithEmailAndPassword(
	getAuth(app),
	process.env.roboUsername,
	process.env.roboPassword,
)
	.then((credential) => {
		process.stdout.write(
			[
				credential.user.uid,
				process.env.HELLO_FLEET_ID,
				process.env.projectId,
				instance,
			].join("\n") + "\n",
		);
		process.exit(0);
	})
	.catch((error) => {
		console.error("ERROR: robot sign-in failed: " + error.message);
		process.exit(1);
	});
EOF
)"

uid="$(echo "$bind_info" | sed -n '1p')"
fleet_id="$(echo "$bind_info" | sed -n '2p')"
project_id="$(echo "$bind_info" | sed -n '3p')"
instance="$(echo "$bind_info" | sed -n '4p')"

if [ -z "$uid" ] || [ -z "$fleet_id" ] || [ -z "$project_id" ] || [ -z "$instance" ]; then
	echo "ERROR: could not resolve the robot uid from .env" >&2
	exit 1
fi

# Bind the robot login so the daemon is allowed to write robots/<fleetId>.
# Writing the same role, name, and uid again is skipped.
binding_changed=0
existing_assignment="$("$FIREBASE" database:get "/assignments/${uid}" \
	--project "$project_id" --instance "$instance")"
if node -e '
	const existing = process.argv[1];
	const fleet = process.argv[2];
	if (!existing || existing.trim() === "null") process.exit(1);
	let data;
	try { data = JSON.parse(existing); } catch (e) { process.exit(1); }
	process.exit(data && data.role === "robot" && data.name === fleet ? 0 : 1);
' "$existing_assignment" "$fleet_id"; then
	echo "Assignment for ${uid} already names ${fleet_id}."
else
	echo "Binding ${fleet_id} to Auth uid ${uid}..."
	"$FIREBASE" database:set "/assignments/${uid}" \
		--data "{\"role\":\"robot\",\"name\":\"${fleet_id}\"}" \
		--project "$project_id" \
		--instance "$instance" \
		--force
	binding_changed=1
fi

existing_uid="$("$FIREBASE" database:get "/robots/${fleet_id}/uid" \
	--project "$project_id" --instance "$instance")"
if node -e '
	const existing = process.argv[1];
	const uid = process.argv[2];
	if (!existing || existing.trim() === "null") process.exit(1);
	let value;
	try { value = JSON.parse(existing); } catch (e) { process.exit(1); }
	process.exit(value === uid ? 0 : 1);
' "$existing_uid" "$uid"; then
	echo "robots/${fleet_id}/uid already matches."
else
	echo "Setting robots/${fleet_id}/uid..."
	"$FIREBASE" database:update "/robots/${fleet_id}" \
		--data "{\"uid\":\"${uid}\"}" \
		--project "$project_id" \
		--instance "$instance" \
		--force
	binding_changed=1
fi

# Install the unit file only when it is missing. Restart only when this
# process is not already publishing standby, so a second run does not
# drop a working robot offline.
service="stretch-web-teleop-daemon.service"
unit="/etc/systemd/system/${service}"
if [ ! -f "$unit" ] || ! systemctl is-enabled --quiet "$service"; then
	echo "Installing the daemon service..."
	./firebase_console_config.sh --install
else
	echo "Daemon service is already installed."
fi

needs_restart=0
if ! systemctl is-active --quiet "$service"; then
	needs_restart=1
else
	since="$(systemctl show -p ActiveEnterTimestamp --value "$service")"
	logs="$(journalctl -u "$service" --since "$since" --no-pager || true)"
	if echo "$logs" | grep -q "PERMISSION_DENIED\|permission_denied"; then
		needs_restart=1
	elif ! echo "$logs" | grep -q "to: standby"; then
		needs_restart=1
	fi
fi

if [ "$needs_restart" -eq 1 ] || [ "$binding_changed" -eq 1 ]; then
	echo "Restarting the daemon..."
	sudo systemctl restart "$service"
else
	echo "Daemon is already running with this binding. Not restarting."
fi

echo "Daemon status:"
systemctl status stretch-web-teleop-daemon.service --no-pager
