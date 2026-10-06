#!/bin/bash
# Onboard this robot onto Hello Robot Cloud (Firebase).
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

# Switch to the branch and grab the latest.
echo "Checking out ${release}..."
git checkout "$release"
git pull

# Install dependencies used by the daemon and the Firebase CLI.
echo "Installing npm dependencies..."
npm install --legacy-peer-deps

# The database bind uses the admin CLI. The robot's own login cannot write it.
if ! "$FIREBASE" login:list 2>/dev/null | grep -q "Logged in as "; then
	echo "Firebase CLI is not logged in."
	echo "Open the URL below on your computer, then paste the code into this terminal."
	"$FIREBASE" login --reauth --no-localhost
fi

# Sign in with the robot account from .env and print the Auth uid.
# roboPassword stays in this process and is not printed.
echo "Signing in as the robot account from .env..."
bind_info="$(node <<'EOF'
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
echo "Binding ${fleet_id} to Auth uid ${uid}..."
"$FIREBASE" database:set "/assignments/${uid}" \
	--data "{\"role\":\"robot\",\"name\":\"${fleet_id}\"}" \
	--project "$project_id" \
	--instance "$instance" \
	--force
"$FIREBASE" database:update "/robots/${fleet_id}" \
	--data "{\"uid\":\"${uid}\"}" \
	--project "$project_id" \
	--instance "$instance" \
	--force

# Install the daemon, then restart it so it picks up the new binding.
echo "Installing the daemon service..."
./firebase_console_config.sh --install

echo "Restarting the daemon..."
sudo systemctl restart stretch-web-teleop-daemon.service

echo "Daemon status:"
systemctl status stretch-web-teleop-daemon.service --no-pager
