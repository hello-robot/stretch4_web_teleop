# Firebase Storage Handler

Firebase is a set of application development platforms and backend cloud computing services. This
project uses three of them:

| Service               | What it is used for                                                              |
| --------------------- | -------------------------------------------------------------------------------- |
| **Hosting**           | Serves the dashboard, operator, and robot pages at `https://<project-id>.web.app` |
| **Authentication**    | Sign-in for human operators and for each robot's own machine account              |
| **Realtime Database** | Fleet state, robot ownership, launch requests, and WebRTC signaling               |

Setting up your own Firebase project will allow you to host a dashboard and grant users permission
to launch and access the web interface without a direct robot connection.
Your robots, users, and data live entirely in a project you create and control. The no-cost [Spark plan](https://firebase.google.com/pricing)
is likely more than sufficient for your project.

## Contents

- [Set-up](#set-up)
- [Adding a map](#adding-a-map)
- [Adding more users](#adding-more-users)
- [Database layout](#database-layout)
- [Security rules](#security-rules)
- [Day-to-day development](#day-to-day-development)
- [Troubleshooting](#troubleshooting)

## Set-up

### Step 1: Check out `main`

In a checkout of this repository:

```bash
git checkout main
git pull
```

If you don't have one, clone it with
`git clone https://github.com/hello-robot/stretch4_web_teleop.git`.

The live site will only deploy if the local branch is `main` with no uncommitted changes or unpushed commits (it matches `origin/main` exactly). Other branches and dirty changes can be deployed to preview channels instead with a unique temporary URL — see
[Day-to-day development](#day-to-day-development).

### Step 2: Create a Firebase project

1. Sign in to the [Firebase console](https://console.firebase.google.com/) with a Google account and
   click **Create a project**.
1. Give it a name and note the generated **project ID**. Google Analytics is optional.

The account you create the project with becomes its **Owner**. You can add more owners later under
**Project settings** → **Users and permissions**.

### Step 3: Add a web app

1. Open **Project settings** (gear icon) → **General** → **Your apps**, and click the web icon (`</>`).
1. Give it a nickname. **Do not** check "Also set up Firebase Hosting for this app".
1. Keep the `firebaseConfig` snippet open for Step 6.

### Step 4: Create the Realtime Database

1. Under **Build**, select **Realtime Database** → **Create Database**.
1. Choose a location, select **Start in locked mode**, and click **Enable**.
1. Copy the database URL at the top of the page, e.g.
   `https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com`.

### Step 5: Enable Authentication

1. Under **Build**, select **Authentication** → **Get started**.
1. Enable **Email/Password**. Leave "email link" off.
1. Enable **Google**, set a public-facing name and support email, and save.
1. Leave **Anonymous** disabled.

### Step 6: Configure `.env` and `.firebaserc`

If there is no `.env` in the repository root yet, create one from
[`.env.example`](../../../../../.env.example), which documents every field.

Fill in the Firebase values from Steps 3 and 4:

```env
PUBLIC_FIREBASE_API_KEY=YOUR_API_KEY
PUBLIC_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT_ID.firebaseapp.com
PUBLIC_FIREBASE_DATABASE_URL=https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com
PUBLIC_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
PUBLIC_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT_ID.firebasestorage.app
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=YOUR_MESSAGING_SENDER_ID
PUBLIC_FIREBASE_APP_ID=YOUR_APP_ID
PUBLIC_FIREBASE_MEASUREMENT_ID=YOUR_MEASUREMENT_ID
```

These values are public and the same for every robot using your project. Each robot's `.env` will need them to connect (Step 9).

Then generate `.firebaserc`:

```bash
node scripts/syncFirebaseRc.js
```

### Step 7: Deploy the site

Sign in with the Google account you created the project with in Step 2:

```bash
npm install --legacy-peer-deps
npm run firebase:login
npm run deploy:firebase
```

If you are running headless, use `./node_modules/.bin/firebase login --reauth --no-localhost` instead of
`npm run firebase:login`.

Your dashboard is now live at `https://YOUR_PROJECT_ID.web.app` 🎉

### Step 8: Add users

In the console, go to **Authentication** → **Users** → **Add user**, and add:

- **One account per robot.** Enter an email and password for the robot. The email doesn't need to be
  a real inbox, e.g. `<fleet-id>@example.com`. Never share one account between robots.
- **Yourself and any other operators.** Enter each person's email and a password.

> \[!NOTE\]
> Operators can skip this and sign in with Google at `https://YOUR_PROJECT_ID.web.app` instead. Their user account is added automatically the first time they sign in.

### Step 9: Configure `.env` on the robot

Get the robot's fleet ID:

```bash
cat /etc/hello-robot/hello-robot.conf | grep HELLO_FLEET_ID
```

First add the 8 shared `PUBLIC_FIREBASE_*` lines to the robot's .env file. Then, fill in the robot specific account details:

```env
# The robot's account from Step 8
ROBOT_USERNAME=<fleet-id>@example.com
ROBOT_PASSWORD=your_secure_password
HELLO_FLEET_ID=stretch-se4-4001
```

`ROBOT_USERNAME` and `ROBOT_PASSWORD` are secrets. Keep them only in the robot's `.env`; never add them
to the webpack allowlist in [`scripts/webpackPublicEnv.js`](../../../../../scripts/webpackPublicEnv.js)
or to a URL so they stay on the robot's computer.

### Step 10: Onboard the robot

From the robot's terminal:

```bash
./onboard_firebase_robot.sh
```

When prompted:

1. Enter your email to give yourself permission to access the robot.
1. Sign in to the Firebase CLI. Open the output URL and sign in with the Google account used to created the project.
1. Enter the robot's `sudo` password to install the background service.

The script is safe to re-run. When it finishes, the robot will appear on your dashboard.

Pass `--email <address>` to skip the first prompt, and `--non-interactive` to fail rather than prompt at
all — useful from a provisioning script, though it needs the Firebase CLI already logged in. On a host
without `systemd`, `--skip-daemon` does the Firebase work and installs no service; that robot can still
be launched by hand with `./launch_interface.sh -f`, it just cannot be started from your
dashboard. Run `./onboard_firebase_robot.sh --help` for the full list.

It does not touch the checkout. The daemon it installs runs this working tree directly, so whatever
branch is checked out is what the robot runs. Changing the code a robot runs is ordinary git work —
`git checkout`, `git pull`, rebuild, relaunch — and needs nothing from Firebase or `.env`. The daemon
publishes the live branch to `robots/<fleetId>/branch`, so each robot's card shows what it is
running; a detached HEAD or an unreadable tree shows `unknown`.

### Step 11: Teleoperate

1. Sign in at `https://YOUR_PROJECT_ID.web.app`. The robot's card reads **Idle** once its daemon
   checks in, and **Offline** when it has not.
1. Set its map with **Change map**, and turn features on or off with **Edit config**. Changing config
   while the interface is running offers **Apply and Restart Interface**.
1. Press **Start Interface**. The card stays **Idle** while it launches, then turns **Ready**.
1. Press **Connect** to take the operator seat and drive. **Stop Interface** tears it back down.
1. One person drives at a time. Everyone else sees the card as **In Use** and the button as
   **In use by \<their email>**, and cannot take the seat until the session ends.

## Adding a map

Maps are provisioned by an administrator. `maps/<mapId>` and `assignments/<identity>/maps` are both
`.write: false`, so no one can upload a map or grant themselves access from the dashboard.

A map's id is the stem of its filename. A robot that has mapped its space with SLAM already has
`~/stretch_user/maps/<mapId>.yaml` next to a `.pgm` of the same name.

### A map the robot already has

This is the common case, and it needs no upload. Grant the person access by map id:

```bash
./node_modules/.bin/firebase database:update "/assignments/<identity>/maps" --data '{"<mapId>":true}'
```

`<identity>` is the Auth uid, or the alias if you set one. The map now appears under **Change map** on
that robot's card, and the daemon loads the copy already on the robot's disk — it prefers a local file
over anything in the database.

### A map the robot does not have

To push a map to a robot that has never seen it, the database record has to carry the map itself. Build
it from the `.yaml` / `.pgm` pair, run from the directory holding them:

```bash
node -e '
const fs=require("fs"),path=require("path");
const id=process.argv[1];
const yaml=fs.readFileSync(id+".yaml","utf8");
const pgm=(yaml.match(/^image:\s*(.+)$/m)||[])[1].trim();
process.stdout.write(JSON.stringify({
  name:id, yaml_content:yaml, pgm_filename:pgm,
  pgm_base64:fs.readFileSync(pgm).toString("base64"),
}));
' <mapId> > map.json
```

Then write it, grant the person, and grant the robot:

```bash
./node_modules/.bin/firebase database:set "/maps/<mapId>" map.json
```

```bash
./node_modules/.bin/firebase database:update "/assignments/<identity>/maps" --data '{"<mapId>":true}'
```

```bash
./node_modules/.bin/firebase database:update "/assignments/<fleetId>/maps" --data '{"<mapId>":true}'
```

The third command is the one that is easy to miss. A robot reads `maps/<mapId>` under its **fleet ID**,
not its Auth uid, so without it the robot cannot read the record and the launch proceeds with no map.
Granting the fleet ID is unnecessary in the local-file case above, because the daemon never needs the
record. Adding `<fleetId>: true` under the map's own `allowed_users` works equally well.

`thumb_png_base64` is optional; set it to a small PNG of the map and the picker shows a thumbnail
instead of a placeholder.

### Notes

- A local file wins. If a robot already has `<mapId>.yaml` on disk, that copy is used and a later edit
  to `maps/<mapId>` will not reach it. Give the revised map a new id, or delete the stale file from
  `~/stretch_user/maps/` on the robot.
- Revoke access the same way you revoke a robot:
  ```bash
  ./node_modules/.bin/firebase database:remove "/assignments/<identity>/maps/<mapId>"
  ```
- Map assignment controls what the dashboard offers, not what the robot can open. Anyone assigned to a
  robot can ask it to load any map file already on that robot's disk.

## Adding more users

1. Add the person as in [Step 8](#step-8-add-users), or have them sign in with Google.

1. On each robot they should see, re-run the onboarding script and enter their email:

   ```bash
   ./onboard_firebase_robot.sh
   ```

Existing users keep their access.

To grant, revoke, or alias access by hand, edit the `assignments` and `uids` paths described in
[Database layout](#database-layout) from the console or the Firebase CLI. For example:

```bash
./node_modules/.bin/firebase database:update "/assignments/<authUid>/robots" --data '{"<fleetId>":true}'
```

> \[!IMPORTANT\]
> Aliases are the easiest of these to get wrong. Once `uids/<authUid>` holds an alias, every
> assignment is read from `assignments/<alias>` and `assignments/<authUid>` is ignored. Adding an
> alias to an account that already has robots or maps means moving that assignment to the new key in
> the same sitting; leaving it behind takes away everything that account could reach, with no error
> anywhere. Write the new node first and delete the old one last, so an interruption leaves a
> duplicate rather than an account pointing at nothing.

### Why maps are assigned twice

A map is assigned to people and, separately, to robots, and the two grants do different work:

- `assignments/<person>/maps` is what the dashboard's map picker offers that person.
- `assignments/<fleetId>/maps` is what the robot's daemon may read out of `maps/<mapId>` when a
  launch asks for a map the robot does not already have on disk.

The second cannot be derived from the first. A security rule sees only the identity making the
request, and that request is made by the robot, so the rule has no way to know which operator asked.
The daemon does check the requesting operator — `ensureMapLocal` in
[`scripts/stretch_firebase_daemon.js`](../../../../../scripts/stretch_firebase_daemon.js) refuses a
map the requester does not hold — but it can only run that check after it has read the map, which
takes a grant of its own.

> \[!WARNING\]
> A map assigned to a person but not to the robot still appears in their picker and the launch still
> proceeds, but the robot logs `Launch will continue without map` and comes up without it unless that
> map's `.yaml` is already in `~/stretch_user/maps/`. When you give someone a new map, give it to the
> robots they drive as well.

## Database layout

| Path                     | Written by    | Purpose                                                                                       |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------- |
| `uids/<authUid>`         | administrator | Optional alias for a human, as a string                                                         |
| `assignments/<identity>` | administrator | `{ robots: { <fleetId>: true }, maps: { <mapId>: true } }` for a human; `identity` is an Auth uid or an alias |
| `assignments/<robotUid>` | administrator | `{ role: "robot", name: "<fleetId>" }` — the robot's machine account                            |
| `robots/<fleetId>/uid`   | administrator | The robot's Auth uid; must match the `assignments` entry above                                  |
| `robots/<fleetId>`       | robot         | `status`, `last_updated`, `branch`, `name`                                                      |
| `robots/<fleetId>`       | operator      | `map_id`, `config/<flag>`, and one-shot `control` launch/stop requests                          |
| `launch_logs/<fleetId>`  | robot         | Streamed launch output, readable by assigned humans                                             |
| `maps/<mapId>`           | administrator | Map metadata, with `owner_uid` and `allowed_users`                                              |
| `rooms/<robotUid>`       | robot, operator | WebRTC signaling, scoped to the robot and its assigned humans                                 |
| `operators/<operatorId>` | operator      | Per-user operator settings, private to that identity                                            |

`./onboard_firebase_robot.sh` writes the three administrator rows a robot needs. The rest of the
administrator-only paths — aliases, map assignments, and additional human grants — are set with the CLI
or the console as shown above.

## Security rules

[`database.rules.json`](../../../../../database.rules.json) is default-deny at the root. In summary:

- **Identities and assignments:** a client may read only its own alias and its own assignment.
  Provisioning writes are administrator-only.
- **Robots:** assigned humans can read a robot and write validated launch, config, and map requests.
  Only the robot's canonical identity can write status and presence fields or consume a control request.
- **Maps:** humans and robots can read only maps that are explicitly assigned, owned, or allowlisted.
  Map writes are administrator-only.
- **Rooms and storage:** only assigned peers can read a signaling room, writes are bound to the
  authenticated uid and operator session, and operator data is private to its own identity.

Signaling deliberately fails closed when a robot's assignment and fleet binding are missing or disagree.
If you ever restore a database from a backup or migrate projects, verify that for every robot
`assignments/<robotUid>.name` and `robots/<fleetId>/uid` agree before expecting robots to come online.

Rules are deployed separately from the application code:

```bash
./node_modules/.bin/firebase deploy --only database --dry-run
```

```bash
./node_modules/.bin/firebase deploy --only database
```

Note that `npm run deploy:firebase` and `npm run deploy:firebase-preview-channel` both deploy the
database rules alongside the bundle. If you are testing a rules change, validate it in a separate
staging Firebase project before running either of those against the project your robots use.

## Day-to-day development

`src/pages/home` is the dashboard; `src/pages/operator` is the teleop interface.

On an onboarded robot a plain launch runs both the local and the Firebase webpack watchers, because
`dual` is the default hosting mode:

```bash
./launch_interface.sh
```

The no-login local operator stays at `https://<robot_ip>/operator`, and the Firebase build is published
to a preview channel for the current checkout. Both URLs connect to the same robot browser and share one
operator seat, so opening one blocks the other until teleoperation ends.

Use `-f` for the Firebase build alone, or `-L` for local only. See
[Primer: Launching the Interface](../../../../primer_launch.md) for the full set of hosting modes.

To publish a one-off build to the preview channel:

```bash
npm run deploy:firebase-preview-channel
```

Preview channel URLs look like `https://YOUR_PROJECT_ID--<channel>-<hash>.web.app`, where the hash is
assigned the first time that channel is deployed. While the development interface is running, saving a
file redeploys the same preview channel: the local tab reloads from webpack, and the preview tab reloads
after the deploy finishes.

For a production robot runtime, set `WEB_TELEOP_BUILD_MODE=production` in `.env`. Launch then creates
one-shot bundles for whichever hosting mode you asked for, instead of starting webpack watchers.
Publishing the live site stays an explicit, separate `npm run deploy:firebase` from clean `main`.

[`firebase_console_config.sh`](../../../../../firebase_console_config.sh) collects the common maintenance
operations:

```bash
./firebase_console_config.sh --install   # create and start the background daemon service
./firebase_console_config.sh --refresh   # clear PM2 processes and restart the daemon; resets status to standby (the card reads **Idle**)
./firebase_console_config.sh --deploy    # build production assets and deploy hosting
```

## Troubleshooting

**`Refusing to publish the live site. This checkout is local-branch-… , not clean origin/main.`**
The live deploy requires a branch named `main`, a clean working tree, and `HEAD` equal to `origin/main`.
Commit and push your changes to your fork, or deploy to a preview channel instead.

**`ERROR: robot sign-in failed`** during onboarding.
The `ROBOT_USERNAME` / `ROBOT_PASSWORD` pair in `.env` does not match a user in **Authentication** → **Users**,
or `PUBLIC_FIREBASE_API_KEY` / `PUBLIC_FIREBASE_AUTH_DOMAIN` / `PUBLIC_FIREBASE_DATABASE_URL` are wrong or missing.

**`No Cloud account uses <email>`** during onboarding.
That address has no account in your project yet. Create it at `https://YOUR_PROJECT_ID.web.app` or in the
console, then enter it again.

**`PERMISSION_DENIED` in the daemon logs.**
The robot's identity rows disagree. Confirm that `assignments/<robotUid>` is
`{ "role": "robot", "name": "<fleetId>" }` and that `robots/<fleetId>/uid` is that same uid, then restart
the daemon:

```bash
sudo systemctl restart stretch-web-teleop-daemon.service
```

**The robot never leaves `offline` in the dashboard.**
Check the daemon:

```bash
systemctl status stretch-web-teleop-daemon.service
```

```bash
journalctl -u stretch-web-teleop-daemon.service -n 100 --no-pager
```

**A deploy or a database command targets the wrong project.**
Check the `default` entry in `.firebaserc`, and confirm which account the CLI is using:

```bash
./node_modules/.bin/firebase login:list
```
