#!/bin/bash
# Onboard this robot onto your own Firebase project.
# Safe to run again if it is interrupted. Steps that already finished are skipped.
set -euo pipefail

cd "$(dirname "$0")"

FIREBASE="./node_modules/.bin/firebase"

operator_email=""
non_interactive=0
skip_daemon=0

usage() {
	cat <<'USAGE'
Usage: ./onboard_firebase_robot.sh [options]

Onboard this robot onto your own Firebase project: bind its robot account,
assign it to an operator, and install the daemon that lets your dashboard
launch it. Safe to run again; finished steps are skipped.

Options:
  --email <address>  Operator to assign this robot to. Prompted for when omitted.
  --non-interactive  Never prompt. Requires --email, a Firebase CLI that is
                     already logged in, and an existing account for that address.
  --skip-daemon      Do the Firebase work only, and install no service. Use on
                     hosts without systemd.
  -h, --help         Show this message.
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
	--email)
		shift
		if [ $# -eq 0 ]; then
			echo "ERROR: --email needs an address" >&2
			exit 1
		fi
		operator_email="$1"
		;;
	--email=*) operator_email="${1#--email=}" ;;
	--non-interactive) non_interactive=1 ;;
	--skip-daemon) skip_daemon=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "ERROR: unknown option: $1" >&2
		usage >&2
		exit 1
		;;
	esac
	shift
done

if [ "$non_interactive" -eq 1 ] && [ -z "$operator_email" ]; then
	echo "ERROR: --non-interactive requires --email" >&2
	exit 1
fi

# Checked before anything is written to Firebase. A host that cannot run the
# daemon should say so now, not after the project has already been modified.
if [ "$skip_daemon" -eq 0 ]; then
	if ! command -v systemctl >/dev/null 2>&1; then
		echo "ERROR: systemctl not found, so the daemon cannot be installed." >&2
		echo "       Re-run with --skip-daemon to do the Firebase work only." >&2
		exit 1
	fi
	if [ "$non_interactive" -eq 1 ] && ! sudo -n true 2>/dev/null; then
		echo "ERROR: --non-interactive needs passwordless sudo to install the daemon." >&2
		echo "       Re-run with --skip-daemon, or grant sudo." >&2
		exit 1
	fi
fi

fleet_id="$(sed -n 's/^HELLO_FLEET_ID=//p' .env | head -n 1 | tr -d '\r"')"
if [ -z "$fleet_id" ]; then
	echo "ERROR: HELLO_FLEET_ID is not defined in .env" >&2
	exit 1
fi

# Ask who should see this robot, then confirm before any other work.
# The first prompt is "Enter your email address:". After n, ask for an
# address to assign to this fleet.
prompt_operator_email() {
	if [ "$non_interactive" -eq 1 ]; then
		echo "ERROR: cannot prompt under --non-interactive." >&2
		exit 1
	fi
	local email_prompt="Enter your email address: "
	while true; do
		read -r -p "$email_prompt" operator_email
		if [ -z "$operator_email" ]; then
			continue
		fi
		while true; do
			read -r -p "Assign ${fleet_id} to ${operator_email}? y / n " answer
			case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
			y | yes) return 0 ;;
			n | no)
				email_prompt="Provide an email address to assign to ${fleet_id}: "
				break
				;;
			*) ;;
			esac
		done
	done
}

if [ -z "$operator_email" ]; then
	prompt_operator_email
else
	echo "Assigning ${fleet_id} to ${operator_email}."
fi

# Finish a partial install. A completed node_modules is left as it is.
if [ -x "$FIREBASE" ] && [ -d node_modules/firebase ] && [ -d node_modules/dotenv ]; then
	echo "npm dependencies already installed."
else
	echo "Installing npm dependencies..."
	npm install --legacy-peer-deps
fi

# projectId is entered once, in .env. Regenerate .firebaserc from it so bare
# `firebase <command>` calls on this robot resolve the same project afterwards.
node scripts/syncFirebaseRc.js || exit 1

# For the remainder of the script, you will need to be an
# Admin or Owner of the Firebase web app.
if ! "$FIREBASE" login:list 2>/dev/null | grep -q "Logged in as "; then
	if [ "$non_interactive" -eq 1 ]; then
		echo "ERROR: the Firebase CLI is not logged in." >&2
		echo "       Run 'npx firebase login' first, or drop --non-interactive." >&2
		exit 1
	fi
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
	"PUBLIC_FIREBASE_PROJECT_ID",
	"PUBLIC_FIREBASE_DATABASE_URL",
	"PUBLIC_FIREBASE_API_KEY",
	"PUBLIC_FIREBASE_AUTH_DOMAIN",
	"ROBOT_USERNAME",
	"ROBOT_PASSWORD",
];
for (const key of required) {
	if (!process.env[key]) {
		console.error("ERROR: " + key + " is not defined in .env");
		process.exit(1);
	}
}

const app = initializeApp({
	apiKey: process.env.PUBLIC_FIREBASE_API_KEY,
	authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
	databaseURL: process.env.PUBLIC_FIREBASE_DATABASE_URL,
	projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID,
});
const instance = new URL(process.env.PUBLIC_FIREBASE_DATABASE_URL).hostname.split(".")[0];

signInWithEmailAndPassword(
	getAuth(app),
	process.env.ROBOT_USERNAME,
	process.env.ROBOT_PASSWORD,
)
	.then((credential) => {
		process.stdout.write(
			[
				credential.user.uid,
				process.env.HELLO_FLEET_ID,
				process.env.PUBLIC_FIREBASE_PROJECT_ID,
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
)" || {
	echo "       ROBOT_USERNAME and ROBOT_PASSWORD in .env must match a user in" >&2
	echo "       Authentication -> Users in your Firebase project. Create that" >&2
	echo "       account in the console first, then run this again." >&2
	exit 1
}

uid="$(echo "$bind_info" | sed -n '1p')"
fleet_id="$(echo "$bind_info" | sed -n '2p')"
project_id="$(echo "$bind_info" | sed -n '3p')"
instance="$(echo "$bind_info" | sed -n '4p')"

if [ -z "$uid" ] || [ -z "$fleet_id" ] || [ -z "$project_id" ] || [ -z "$instance" ]; then
	echo "ERROR: could not resolve the robot uid from .env" >&2
	exit 1
fi

# The dashboard lists a robot under assignments/<alias>/robots/<fleetId>.
# alias is uids/<auth uid>, or the Auth uid when that entry is missing.
while true; do
	auth_export="$(mktemp)"
	trap 'rm -f "$auth_export"' EXIT
	"$FIREBASE" auth:export "$auth_export" --format=json --project "$project_id" >/dev/null
	if operator_auth_uid="$(
		node -e '
			const fs = require("fs");
			const email = process.argv[1].toLowerCase();
			const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
			const user = (data.users || []).find(
				(entry) => (entry.email || "").toLowerCase() === email,
			);
			if (!user || !user.localId) process.exit(1);
			process.stdout.write(user.localId);
		' "$operator_email" "$auth_export"
	)"; then
		found_operator=1
	else
		found_operator=0
		operator_auth_uid=""
	fi
	rm -f "$auth_export"
	trap - EXIT
	if [ "$found_operator" -eq 1 ] && [ -n "$operator_auth_uid" ]; then
		break
	fi
	echo "No Cloud account uses ${operator_email}. Create one at https://${project_id}.web.app, then enter the email again."
	prompt_operator_email
done

alias_raw="$("$FIREBASE" database:get "/uids/${operator_auth_uid}" \
	--project "$project_id" --instance "$instance")"
operator_alias="$(
	node -e '
		const raw = process.argv[1];
		const uid = process.argv[2];
		if (!raw || raw.trim() === "null") {
			process.stdout.write(uid);
			process.exit(0);
		}
		let value;
		try {
			value = JSON.parse(raw);
		} catch (e) {
			process.stdout.write(uid);
			process.exit(0);
		}
		process.stdout.write(typeof value === "string" && value ? value : uid);
	' "$alias_raw" "$operator_auth_uid"
)"

existing_operator_robot="$("$FIREBASE" database:get "/assignments/${operator_alias}/robots/${fleet_id}" \
	--project "$project_id" --instance "$instance")"
if node -e '
	const existing = process.argv[1];
	if (!existing || existing.trim() === "null") process.exit(1);
	let value;
	try { value = JSON.parse(existing); } catch (e) { process.exit(1); }
	process.exit(value === true ? 0 : 1);
' "$existing_operator_robot"; then
	echo "${fleet_id} is already assigned to ${operator_email}."
else
	echo "Assigning ${fleet_id} to ${operator_email}..."
	"$FIREBASE" database:update "/assignments/${operator_alias}/robots" \
		--data "{\"${fleet_id}\":true}" \
		--project "$project_id" \
		--instance "$instance" \
		--force
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

if [ "$skip_daemon" -eq 1 ]; then
	echo "Skipping the daemon service (--skip-daemon)."
else
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
fi

if [ "$skip_daemon" -eq 0 ]; then
	echo "Daemon status:"
	systemctl status stretch-web-teleop-daemon.service --no-pager
fi
