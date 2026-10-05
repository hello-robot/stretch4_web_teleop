# README

## Overview

This interface enables a user to remotely teleoperate a Stretch robot through a web browser. This website can be set up to teleoperate the robot remotely from anywhere in the world with an internet connection, or simply eyes-off teleop from the next room on a local network. The codebase is built on ROS2, WebRTC, Nav2, and TypeScript.

## Setup & Installation

The interface is compatible with the Stretch 4. It currently only supports Ubuntu 24.04 and ROS2 Humble. Upgrade your operating system if necessary ([instructions](https://docs.hello-robot.com/0.3/installation/robot_install/)) and create/update the Stretch ROS2 Humble workspace ([instructions](https://docs.hello-robot.com/0.3/installation/ros_workspace/)). This will install all package dependencies and install the web teleop interface.

## Launching the Interface

First, navigate to the folder containing the codebase using:

```
colcon_cd stretch4_web_teleop
```

Next, launch the interface:

```
./launch_interface.sh
```

In the terminal, you will see output similar to:

```
Visit the URL(s) below to see the web interface:
https://localhost/operator
https://192.168.1.14/operator
```

Look for a URL like `https://<ip_address>/operator`. Visit this URL in a web browser on your personal laptop or desktop to see the web interface. Ensure your personal computer is connected to the same network as Stretch. You might see a warning that says "Your connection is not private". If you do, click `Advanced` and `Proceed`.

Once you're done with the interface, close the browser and run:

```
./stop_interface.sh
```

**Note:** Only one browser can be connected to the interface at a time.

## Firebase

Hello Robot Cloud is built with Firebase providing a hosted dashboard, sign-in, and an organized space to view the Stretch robots in your fleet. Hello Robot Cloud allows you to access your Stretch anytime – no Tailscale or ngrok is needed.

- [Working on the Firebase app](#working-on-the-firebase-app)
- [How to Teleoperate Your Stretch from Hello Robot Cloud](#how-to-teleoperate-your-stretch-from-hello-robot-cloud)

### Working on the Firebase app

This mode serves the `home`, `operator`, and `robot` pages from Firebase Hosting and keeps robot state in the Realtime Database. The dashboard lists assigned robots, starts the interface on the robot, and opens the operator room. Signaling and the operator seat live in [`FirebaseSignaling.ts`](src/shared/signaling/FirebaseSignaling.ts). The onboard process that applies launch, stop, map, and config is [`scripts/stretch_firebase_daemon.js`](scripts/stretch_firebase_daemon.js).

Only Firebase's public web-app configuration and fleet identifier are compiled into those pages. The robot email/password stays in the robot's gitignored `.env`; `start_robot_browser.js` injects it into the local headless browser context without putting it in a bundle, URL, or HTTP log.

To change the dashboard, start in [`src/pages/home`](src/pages/home). To change how a session joins or who holds the operator seat, start in the signaling code. To change what a launch actually starts, start in the daemon and [`launch_interface_firebase.sh`](launch_interface_firebase.sh).

#### Run and iterate locally

`./launch_interface.sh` watches this checkout and rebuilds `dist-firebase/` on save when `.env` is filled in. Pass `-f` to force Firebase mode. A tab on the robot (`https://localhost` or `https://<robot-ip>`) reloads itself. The robot page (`/robot`) does not. Restart it with `pm2 restart start_robot_browser`.

#### Publish a preview

You don't have to launch the interface to publish this checkout:

```
npm run build:firebase-preview-channel
```

That builds `dist-firebase/` and runs `firebase hosting:channel:deploy` for this checkout. It does not update [https://stretch4-web-interface.web.app](https://stretch4-web-interface.web.app). The channel is `branch-<name>` when the worktree is clean and `HEAD` matches `origin/<name>` (`/` `:` `_` `#` in the branch name become `-`). Otherwise it is `local-branch-<name>`.

The preview URL looks like `https://stretch4-web-interface--<channel>-<hash>.web.app`. The hash is assigned the first time that channel is deployed and does not change. `/operator/?robot=` is the same host with that path. While the interface is running, a save uploads the same preview channel. The preview tab reloads a couple of seconds after the upload.

### How to Teleoperate Your Stretch from Hello Robot Cloud

1. On the robot, fill in `.env` so the daemon can log in:

   - `apiKey`
   - `authDomain`
   - `databaseURL`
   - `projectId`
   - `storageBucket`
   - `messagingSenderId`
   - `appId`
   - `measurementId`
   - `roboUsername` (the robot's Firebase email)
   - `roboPassword`
   - `HELLO_FLEET_ID`

   Then run `./firebase_console_config.sh --install`. After that completes, run `sudo reboot now`. Do this before you create an account. The daemon has to be installed and Stretch has to reboot first.
2. Create an account at [https://stretch4-web-interface.web.app](https://stretch4-web-interface.web.app).
3. Ask for your Stretch to be added to that account. Send the robot's fleet ID. An administrator must bind the robot Auth uid in both `assignments/<robotAuthUid> = { role: "robot", name: "<fleetId>" }` and `robots/<fleetId>/uid = "<robotAuthUid>"`, then add the fleet ID under your `assignments/<alias>/robots`.
4. Sign in. The robot should appear as standby. Choose its map and config, then press **Teleoperate**.
5. The interface starts on the robot when you press **Teleoperate**. It does not start on its own after a reboot. The hosted site stays up across a reboot, and the onboard daemon returns the robot to standby.

One person operates a robot at a time. A second user sees **Currently in Use** and cannot stop that session or take the seat. End teleoperation before someone else connects.

Realtime Database access is default-deny. Run `npm run test:security` before changing [`database.rules.json`](database.rules.json). Hosting deploys do not publish database rules; follow the staged rules rollout in the Firebase storage-handler README. If a robot password was ever included in a previously published bundle, rotate it after the secure build is deployed.

## Feature flags

Optional features are declared in [`features.json`](features.json), which is
the single source of truth for each flag's name, default, and description:

```json
{
    "<flag_name>": {
        "enabled": false,
        "description": "..."
    }
}
```

Edit `features.json` to change a flag's default. To override a flag for a
single run without editing the file, set `FEATURE_<NAME>` in the environment
(`<NAME>` is the flag name upper-cased), which accepts `1`/`0`, `true`/`false`,
`yes`/`no` or `on`/`off`:

```
FEATURE_<NAME>=1 ./launch_interface.sh
```

Each flag is read at launch by `server.js`, which registers the routes it
gates only when it is on, and by `webpack.config.js`, which substitutes it
into the bundle as `process.env.FEATURE_<NAME>`. Changing it therefore takes
effect on the next `./launch_interface.sh`. Grep for `@flag <flag_name>` to
find every seam for a given flag.

## Using the Interface Remotely

**WARNING: This is prototype code and there are security issues. Deploy this code at your own risk.**

We recommend setting up the interface for remote use using [ngrok](https://ngrok.com/docs/what-is-ngrok/). First, create an account with `ngrok` and follow the Linux installation instructions in the `Setup & Installation` tab in your ngrok account dashboard.

Navigate to the `Domains` tab and click `Create Domain`. ngrok will automatically generate a domain name for your free account. You will see a domain similar to `deciding-hornet-purely.ngrok-free.app`. Follow the interface launch instructions and then start the ngrok tunnel by running the following command (replace `<NGROK_DOMAIN>` with your account's domain and `user:password` with a secure username and password):

```
ngrok http --basic-auth="user:password" --domain=<NGROK_DOMAIN> 443
```

In your browser, open `https://<NGROK_DOMAIN>/operator` to see the interface. You will then be prompted to enter the appropriate username and password. Note, anyone in the world with internet access can open this link.

### Storing Ngrok Tunnel Configuration

To store this configuration, open the ngrok config file:

```
ngrok config edit
```

Add the following configuration to the file. Make sure to update `<NGROK_AUTH_TOKEN>`, `<NGROK_DOMAIN>`, and `admin:password` with the appropriate values.

```
authtoken: <NGROK_AUTH_TOKEN>
version: 2
tunnels:
    stretch-web-teleop:
        proto: http
        domain: <NGROK_DOMAIN>
        addr: 443
        basic_auth:
          - "admin:password"
        host_header: rewrite
        inspect: true
```

Now run `ngrok start stretch-web-teleop` to start the tunnel and navigate to `https://<NGROK_DOMAIN>/operator`. You will then be prompted to enter the appropriate username and password.

## Developer Docs

The following primers provide a high-level introduction to the codebase for developers.

| Primer                                                       | Description                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Software Architecture](src/primer_software_architecture.md) | Overview of the system architecture — how the robot browser, operator browser, ROS2, and WebRTC fit together. Includes a render logic flow diagram showing how `MobileOperator` is structured into scenes, function providers, and the global footer.                             |
| [Operator Page](src/primer_operator.md)                      | Deep dive into the operator page codebase — directory layout, the shared layer (`commands`, `RemoteRobot`, `util`, `webrtcconnections`), the entry point (`index.tsx`), function providers, component folders, storage handler, and a step-by-step guide for adding new features. |
| [Robot Page](src/primer_robot.md)                            | Deep dive into the robot page codebase — the `Robot` class, ROS2 subscriptions/services/actions, robot modes, joint state processing, video streams, and the full bidirectional data flow between ROS2 and the operator browser.                                                  |

## Contributing

- This repository uses pre-commit hooks to enforce consistent formatting and style.
  - Install pre-commit: `python3 -m pip install pre-commit`
  - Install the hooks locally: `cd` to the top-level of this repository and run `pre-commit install`.
  - Moving forward, pre-commit hooks will run before you create any commit.

## Troubleshooting

### Collecting logs

First, ensure that your robot has the latest version of Web Teleop by [updating your ROS workspace](https://docs.hello-robot.com/0.3/installation/ros_workspace/).

Then, launch the program normally, and if you see "FAILURE. COULD NOT LAUNCH WEB TELEOP.", then locate the zipped-up logs file and send them to Hello Robot Support (support@hello-robot.com).

To locate the logs, open a file explorer, go into "Home", go into "stretch_user", go into "log", go into "web_teleop", locate the folder with the latest timestamp, and send "stretch4_web_teleop_logs.zip" to the support team.

## Licenses

The following license applies to the contents of this directory written by Vinitha Ranganeni, Noah Ponto, authors associated with the University of Washington, and authors associated with Hello Robot Inc. (the "Contents"). This software is intended for use with Stretch ® mobile manipulators produced and sold by Hello Robot ®.

Copyright 2023 Vinitha Ranganeni, Noah Ponto, the University of Washington, and Hello Robot Inc.

The Contents are licensed under the Apache License, Version 2.0 (the "License"). You may not use the Contents except in compliance with the License. You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, the Contents are distributed under the License are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

\============================================================

Some of the contents of this directory derive from the following repositories:

https://github.com/hello-robot/stretch_web_teleop

https://github.com/hello-robot/stretch_web_interface

https://github.com/hcrlab/stretch_web_interface

https://github.com/hcrlab/stretch_teleop_interface

Text from relevant license files found in these repositories.
