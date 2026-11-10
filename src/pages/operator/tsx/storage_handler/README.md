# Firebase Storage Handler

Firebase is a set of application development platforms and backend cloud computing services. This
project uses three of them:

| Service               | What it is used for                                                       |
| --------------------- | ------------------------------------------------------------------------- |
| **Hosting**           | Serves the dashboard and operator pages at `https://<project-id>.web.app` |
| **Authentication**    | Sign-in for human operators and for each robot's own machine account       |
| **Realtime Database** | Fleet state, robot ownership, launch requests, and WebRTC signaling        |

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
- [Releases and rails](#releases-and-rails)
- [Day-to-day development](#day-to-day-development)
- [Troubleshooting](#troubleshooting)

## Set-up

### Step 1: Check out a release tag

If you do not have a checkout of this repository yet, clone it with
`git clone https://github.com/hello-robot/stretch4_web_teleop.git`.

The live site deploys from a clean checkout of a release tag listed in
[`release.json`](../../../../../release.json) (see [Releases and rails](#releases-and-rails)). Fetch
tags and check out a listed release tag:

```bash
git fetch --tags
git checkout <tag>
```

If you are setting up a brand-new fork where that tag does not exist yet, create it first with
`git tag -a <tag> -m "Release <tag>" && git checkout <tag>`.

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

### Step 6: Configure `.env`

If there is no `.env` in the repository root yet, create one from
[`.env.example`](../../../../../.env.example), which documents every field.

Fill in the Firebase values from Steps 3 and 4, plus your Hosting origin:

```env
PUBLIC_FIREBASE_API_KEY=YOUR_API_KEY
PUBLIC_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT_ID.firebaseapp.com
PUBLIC_FIREBASE_DATABASE_URL=https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com
PUBLIC_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
PUBLIC_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT_ID.firebasestorage.app
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=YOUR_MESSAGING_SENDER_ID
PUBLIC_FIREBASE_APP_ID=YOUR_APP_ID
PUBLIC_FIREBASE_MEASUREMENT_ID=YOUR_MEASUREMENT_ID
PUBLIC_HOSTING_ORIGIN=https://YOUR_PROJECT_ID.web.app
```

These values are public and the same for every robot using your project. Each robot's `.env` will need
them to connect (Step 9). `.firebaserc` is synced automatically from `PUBLIC_FIREBASE_PROJECT_ID` when
you deploy or onboard a robot (or manually with `node scripts/syncFirebaseRc.js`).

### Step 7: Deploy the site

Sign in with the Google account you created the project with in Step 2 and deploy the database rules
and Hosting bundle:

```bash
npm install --legacy-peer-deps
npm run firebase:login
npm run deploy:rules
npm run deploy:hosting
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

First copy the shared `PUBLIC_*` lines from Step 6 into the robot's `.env` file. Then fill in the
robot-specific account details:

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
1. Sign in to the Firebase CLI. Open the output URL and sign in with the Google account used to create the project.
1. Enter the robot's `sudo` password to install the background service.

The script is safe to re-run. When it finishes, the robot will appear on your dashboard.

Pass `--email <address>` to skip the first prompt, and `--non-interactive` to fail rather than prompt at
all — useful from a provisioning script, though it needs the Firebase CLI already logged in. On a host
without `systemd`, `--skip-daemon` does the Firebase work and installs no service; that robot can still
be launched by hand with `./launch_interface.sh -f`, it just cannot be started from your
dashboard. Run `./onboard_firebase_robot.sh --help` for the full list.

Onboarding does not modify the git checkout. The daemon runs whatever commit is checked out in this
working tree and publishes its git build description to `robots/<fleetId>/build` (and branch name to
`robots/<fleetId>/branch`) so each robot's card shows what version it is running. Keep fielded robots
checked out on a release tag listed in `release.json`; changing the version a robot runs is ordinary
git work (`git fetch --tags`, `git checkout <tag>`, rebuild, relaunch) and needs no changes in Firebase
or `.env`.

### Step 11: Teleoperate

1. Sign in at `https://YOUR_PROJECT_ID.web.app`. The robot's card reads **Idle** once its daemon
   checks in, and **Offline** when it has not.
1. Set its map with **Change map**, and turn features on or off with **Edit config**. Changing config
   while the interface is running offers **Apply and Restart Interface**.
1. Press **Start Interface**. While it launches, the status stays **Idle** and **LOGS** streams the
   startup output; once the interface is up, the card turns **Ready** and opens the operator page (or
   waits for **Connect** if you opened **LOGS**).
1. Press **Connect** to take the operator seat and drive. **Stop Interface** tears it back down.
1. One person drives at a time. Everyone else sees the card as **In Use** and the button as
   **Stop Interface** (**In use by \<their email>**), and cannot take the seat until the session ends.

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
| `robots/<fleetId>`       | robot         | `status`, `last_updated`, `branch`, `build`, `name`                                             |
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

Deploy database rules separately from the site with:

```bash
npm run deploy:rules
```

This syncs `.firebaserc`, pulls the ruleset the project is currently enforcing, and prints a line by
line diff of it against `database.rules.json`. Nothing is uploaded until you agree to the diff at the
prompt. On a yes it runs the rules test suite (`npm run test:firebase-rules`) against the local
emulator and uploads `database.rules.json` when the suite passes.

A deploy replaces the whole ruleset rather than patching it, so a repository copy that has fallen
behind reverts whatever it is missing. Read the removed lines in the diff before answering: they are
rules the project enforces today. The suite gates only what it covers, so it will not catch a rule it
has no case for.

Pass `--no-check` to skip the diff and the prompt, for an unattended deploy:

```bash
npm run deploy:rules -- --no-check
```

Without it, a run with no terminal to ask stops rather than assuming consent. Validate rules changes
in a separate staging Firebase project before running `npm run deploy:rules` against a project with
active robots.

## Releases and rails

The site serves two things:

- **The lobby (`/`) and the unversioned operator page (`/operator/`)** — the fleet dashboard and its
  fallback interface, built from the GitHub release marked **Latest** and from nothing else.
- **Rails (`/r/<tag>/operator/`)** — immutable copies of each released operator interface, served side
  by side so robots running different software versions can share one dashboard.

Which rail an operator gets is decided per robot. The robot's daemon publishes the tag its checkout is
sitting on to `robots/<fleetId>/build`, and clicking **Connect** on its card opens `/r/<tag>/operator/`.
If a robot is on a release tag that the site does not serve, the card shows an outlined box reading
`Release <tag> is not deployed` in place of **Start Interface** and **Connect**. **Stop Interface** stays
available while the interface is running.

A robot with commits or uncommitted changes on top of a release tag is treated as that tag. The daemon
publishes `git describe`, which names the nearest release tag behind the checkout (for example
`v0.2.0-alpha2-3-g46cf732-dirty`), and the card routes to that tag's rail: **Connect** opens
`/r/<tag>/operator/`, or is replaced by the same box if that rail is not on the site. A warning above the
buttons says the robot has changes outside of the tag, and the tag name under them turns red. A checkout
with no release tag behind it warns that it is not a release and opens the default rail instead.

[`release.json`](../../../../../release.json) lists the tags that stay published on the site:

```json
{ "rails": ["v0.1.0-alpha1", "v0.1.0"] }
```

Every `npm run deploy:hosting` run builds the rail for the current checkout, carries forward the other
rails listed in `release.json`, and removes any rail no longer in that list. What it does with the
lobby and `/operator/` depends on the tag being deployed:

| Tag being deployed | Lobby and `/operator/` | Rails |
| :--- | :--- | :--- |
| The GitHub release marked **Latest** | Rebuilt from this tag | `/r/<tag>/` built, the rest carried |
| Any other tag (an alpha, beta, rc, or an older release) | Left exactly as the live site serves them | `/r/<tag>/` built, the rest carried |

A deploy that leaves the lobby in place prints `lobby  unchanged (carried from the live version)` and
publishes nothing outside `/r/`. The one exception is a Firebase project with no live release at all,
which has no lobby to keep, so its first deploy builds one from whichever tag is deployed.

To cut and publish a release, add the new tag to `release.json` **before** tagging (the file is read
from the tagged commit):

```bash
git add release.json && git commit -m "retain <tag>" && git push
git tag -a <tag> -m "Release <tag>" && git push origin <tag>
git checkout <tag>
npm run deploy:hosting
```

To make a release the one the lobby is built from, publish its GitHub release as **Latest** first and
then run `npm run deploy:hosting` from its tag. Deploying before the GitHub release is published adds
the rail and leaves the lobby alone; run the deploy again afterwards to update the lobby. A fix to the
lobby itself therefore ships as a new **Latest** release.

The default rail (used when a robot reports no release tag of its own) is that same **Latest** release,
baked into the lobby when it is built. The lobby publishes what it was built from at `/lobby.json`
(`tag`, `commit`, `stable`, `built`). A deploy that leaves the lobby in place reads that file and
refuses to retire the rail the lobby defaults to.

Rails are immutable on the live site: a deploy that would overwrite an existing `/r/<tag>/` from a
different commit refuses rather than replacing it.

## Day-to-day development

`src/pages/home` is the dashboard; `src/pages/operator` is the teleop interface.

### Live development on a robot (`./launch_interface.sh -f`)

On an onboarded robot, pass `-f` / `--firebase` (or set `HOSTING_MODE=firebase` in `.env`) to run both
the local and the Firebase webpack watchers:

```bash
./launch_interface.sh -f
```

- The no-login local operator stays at `https://<robot_ip>/local/operator/`.
- The Firebase build is served at `https://<robot_ip>/operator/` and automatically published to a
  preview channel (`branch-<branch>` or `local-branch-<branch>`) for the current checkout.
- Saving a file rebuilds webpack and redeploys that preview channel automatically.

Both URLs connect to the same robot browser and share one operator seat, so opening one blocks the
other until teleoperation ends.

Without `-f` (or `HOSTING_MODE=firebase`), `./launch_interface.sh` defaults to `local` only. Use
`--local` (or `--hosting local`) to override a standing `HOSTING_MODE=firebase` for a single local-only
run. See [Primer: Launching the Interface](../../../../primer_launch.md) for the full resolution rules.

### Testing rails and staging releases (`npm run deploy:hosting`)

Whereas `./launch_interface.sh -f` publishes a flat single-version build to `branch-<branch>`,
`npm run deploy:hosting` builds the multi-version site: on a live deploy, a versioned rail
(`/r/<tag>/operator/`) built from `HEAD`, plus the lobby (`/`) and the unversioned operator page
(`/operator/`) when `HEAD` is the **Latest** release (see [Releases and rails](#releases-and-rails)).
A preview always builds its own lobby and `/operator/`.

It needs one thing from you: **where to publish** — the live site (`https://YOUR_PROJECT_ID.web.app`)
or a preview channel (`rails-<branch|tag>`).

The rail's name is never supplied by hand. It is read from git, and a live deploy requires `HEAD` to be
a clean `v*` release tag listed in `release.json`. That is what makes a rail reproducible: the name it
is served under is the name you check out to rebuild it.

| Goal | Checkout state | Command | Where it publishes |
| :--- | :--- | :--- | :--- |
| **Publish a release live** | Clean `v*` tag in `release.json` | `npm run deploy:hosting` | Live site (`YOUR_PROJECT_ID.web.app`), serving `/r/<tag>/operator/`; the lobby and `/operator/` change only if the tag is **Latest** |
| **Inspect a release before going live** | Clean `v*` tag | `npm run deploy:hosting -- --preview` | Preview channel `rails-<tag>`: the lobby and `/operator/`, which is that tag's interface |
| **Test a branch or a dirty tree** | Any branch or uncommitted edits | `npm run deploy:hosting -- --preview` | Preview channel `rails-<branch>`: the lobby and `/operator/`, built from `HEAD` |

**What `--preview` does.** It publishes to a temporary `rails-<branch|tag>` channel instead of the live
site. A preview channel carries one interface, so it publishes no rails and routes every card to
`/operator/` — the build that channel is already serving, which is why there is nothing there to
version. Use it to look at a change from a branch, from a dirty tree, or from a release tag you have
not published yet.

Preview channel URLs look like `https://YOUR_PROJECT_ID--<channel>-<hash>.web.app`. `deploy:hosting`
uses the `rails-` channel prefix so manual rail previews never overwrite the `branch-` preview channels
used by a robot's `./launch_interface.sh -f` autodeploy.

### Production robot runtime and maintenance

For a production robot runtime, set `WEB_TELEOP_BUILD_MODE=production` in `.env`. Launch then creates
one-shot bundles for whichever hosting mode you asked for, instead of starting webpack watchers.
Publishing the live site stays an explicit, separate `npm run deploy:hosting` from a clean release
tag.

[`firebase_console_config.sh`](../../../../../firebase_console_config.sh) collects the common maintenance
operations:

```bash
./firebase_console_config.sh --install   # create and start the background daemon service
./firebase_console_config.sh --refresh   # clear PM2 processes and restart the daemon; resets status to standby (the card reads **Idle**)
./firebase_console_config.sh --deploy    # build production assets and deploy hosting
```

## Troubleshooting

**`this checkout is not a release: …`**
A live deploy builds `/r/<tag>/operator/` from `HEAD`, so `HEAD` must be a clean `v*` tag listed in
`release.json`. Check one out, or publish this checkout to a preview channel instead with
`npm run deploy:hosting -- --preview`.

**`the live lobby routes to <tag> by default, and release.json does not retain it`**
The tag being deployed is not the **Latest** release, so the live lobby stays in place, and that lobby
sends robots with no release of their own to `<tag>`. Add `<tag>` back to `release.json`, or deploy the
**Latest** release first so the lobby is rebuilt against it.

**The lobby did not change after a deploy.**
The deployed tag is not the GitHub release marked **Latest**. Publish it as **Latest** and run
`npm run deploy:hosting` from the tag again.

**A card shows `Release <tag> is not deployed` instead of Start Interface or Connect.**
The robot is on, or has changes on top of, a tag that `release.json` no longer retains, so `/r/<tag>/`
is not on the site. Either add the tag back and redeploy, or check the robot out onto a tag that is
still served.

**A card warns that the robot has changes outside of a tag.**
The robot has commits or uncommitted changes on top of that release tag, and the card opens that tag's
interface, which may not match what the robot is running. Expected on a development robot; test the
branch on its preview channel, or check out a release tag.

**A card warns that the robot's checkout is not a release.**
No release tag is behind the robot's checkout, so no rail matches it and the card opens the default
interface instead.

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
Check `PUBLIC_FIREBASE_PROJECT_ID` in `.env`, run `node scripts/syncFirebaseRc.js` to sync `.firebaserc`,
and confirm which account the CLI is using:

```bash
./node_modules/.bin/firebase login:list
```
