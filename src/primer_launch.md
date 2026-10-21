# Launching the Interface

A launch brings up three things in order: the `ROS2` drivers, a local HTTPS server, and a headless robot browser that joins a signaling room and waits for an operator. Two entry points start that sequence — a person at a terminal, and the onboard Firebase daemon acting on a request from a dashboard. Both run the same code to do it.

What differs between them is the **hosting mode**: which host serves the operator interface.

## Hosting modes

The robot's own `express` server runs in every mode. The hosting mode decides where an operator *fetches* the interface from, and with it which signaling transport the robot browser joins.

| Mode | Doors open | Bundles built | Robot's signaling |
| --- | --- | --- | --- |
| `local` | LAN only | `dist/` | `LocalSignaling` over `socket.io` |
| `firebase` | LAN **and** cloud | `dist/` and `dist-firebase/` | `TeleopSignalingCoordinator`, both at once |

There is no `dual`. `--firebase` *adds* the cloud door rather than replacing the LAN one, so the configuration that used to be called dual is simply what `firebase` means now — and the operator picks a door by URL, not by launch flag.

The LAN bundle is built in both modes, because the LAN door is what keeps working when the cloud does not. In `local` mode the robot browser uses `LocalSignaling` over `socket.io`. In `firebase` mode it runs `TeleopSignalingCoordinator`, which joins both the `socket.io` room and the Realtime Database and lets whichever operator arrives first hold the session; the other is ignored with `Ignoring ${transport} operator while another transport is active`.

## Operator URLs

One meaning per URL, in every mode. This is the point of the split: it used to be possible to believe you were testing the cloud while driving over the LAN.

| URL | Serves | Signaling | Modes |
| --- | --- | --- | --- |
| `https://<host>/local/operator/` | LAN bundle | `socket.io`, no WAN needed | both |
| `https://<host>/operator/` | cloud bundle | Firebase | `firebase`; redirects (302) to `/local/operator/` under `local` |
| `https://<project-id>.web.app/operator` | cloud bundle, from Hosting | Firebase | `firebase` |

The redirect is deliberate rather than a 404: the address bar changes, so an operator can see which door they landed in. No URL ever silently serves a different bundle.

`/robot/` exists in both modes and is the robot's own page, loaded from loopback by `start_robot_browser.js`. Opening it by hand gets you nothing — credentials are injected only into that trusted Playwright context, on loopback, so any other robot page fails closed.

The Firebase modes are optional and self-hosted: they work only if you have set up a Firebase project under your own account and deployed a dashboard into it, which is what [`onboard_firebase_robot.sh`](pages/operator/tsx/storage_handler/README.md) does. Nothing here is operated by Hello Robot.

## Launch intents

Choosing hosts is only half of what a launch decides. The other half is what counts as a failure worth printing — and those are different questions.

`launch_interface.sh` resolves one binary flag into one of two intents. **Local is the default**: a launch that names nothing asks for the LAN door and nothing else.

| Intent | Set by | Opens | Fatal when |
| --- | --- | --- | --- |
| `ARG_LOCAL` | no flag — the default — or `WEB_TELEOP_HOSTING=local` | the LAN door | the installation does not validate |
| `ARG_FIREBASE` | `-f`, `--firebase`, or `WEB_TELEOP_HOSTING=firebase` | the LAN door **and** the cloud door | Firebase is unavailable |

The flag is additive and has no negating form, so a standing `WEB_TELEOP_HOSTING=firebase` is overridden for one run from the environment instead:

```bash
WEB_TELEOP_HOSTING=local ./launch_interface.sh
```

**A bare launch never probes Firebase at all** — no sign-in, no `assignments/<uid>` read, no network call. A robot that was never onboarded is not merely quiet about Firebase; it is never asked.

And **nothing downgrades**. `--firebase` on a robot whose Firebase is broken is an error, resolved by relaunching without the flag. It is never silently served as local, which is what made the old `dual` mode ambiguous to troubleshoot.

| Intent | `fb_status` | Outcome |
| --- | --- | --- |
| `ARG_LOCAL` | not checked | `local`, quiet |
| `ARG_FIREBASE` | `0` | `firebase`, quiet |
| `ARG_FIREBASE` | `2` or `3` | error, exit 1 |

> _**NOTE:**_ Hosting mode is a different axis from Hosting *deploys*. `WEB_TELEOP_AUTODEPLOY=0` stops preview-channel uploads while Firebase Hosting carries on serving the build it already has. A robot can be in `firebase` hosting mode with deploys switched off.

## Two ways to launch

There is **one launch path**, and both entry points take it.

**From a terminal**, `./launch_interface.sh` does the whole launch: it parses its flag, validates the installation, resolves the intent, probes Firebase when the cloud door was asked for, locks `HOSTING_MODE`, runs `start_ros2.sh` and then `start_web_server_and_robot_browser.sh`, and prints the URLs an operator should visit.

Flags are parsed before the installation is validated, so `--help` and a misspelled flag are answered without an `npm list` on a checkout that may not have one. Everything after that waits for validation to pass, because a checkout that cannot build has nothing to say about which door should open.

**From your dashboard**, `stretch_firebase_daemon.js` receives a command over the Realtime Database and spawns **the same script with the same flag**: `./launch_interface.sh -f`, with `WEB_TELEOP_LOG_DIR` in the child environment so the run lands in a directory the daemon is already tailing.

That means the daemon re-runs a Firebase probe its claim has already proved. The database rules gate `robots/$fleetId` on exactly the predicate `checkFirebaseRobotAccess.js` asserts — `assignments/<uid>/role === 'robot'`, `name === $fleetId`, `robots/$fleetId/uid === auth.uid` — so a daemon that received a claim and is reporting status has satisfied it. The probe costs one redundant sign-in, typically a second or two.

That redundancy is the price of there being one path. A second path to avoid one gate means every future divergence compounds; if probe flakiness ever proves real, the fix is a retry inside `check_firebase_readiness`, which helps both callers.

Two scripts were deleted on the way here. `launch_interface_firebase.sh` parsed `-m` and resolved `teleop_log_dir`, both of which were already done downstream, and the daemon judged success by exit code alone. `launch_teleop_stack.sh` was the shared spine for as long as a second front door called it; once the daemon came through the front door, a spine with one caller was indirection for its own sake, so `start_ros2.sh` and `start_web_server_and_robot_browser.sh` are invoked from `launch_interface.sh` directly.

## All launch paths

Every path through a launch, the script that owns each step, the argument that chooses between them, and what each of the signaling preflight's exit codes produces, is drawn in [`launch_paths.md`](../.gitbook/assets/launch_paths.md).

It is mermaid in a fenced block, so it renders inline and is edited as text. There is no generated image beside it to keep in step.

## After the mode is locked

Once `HOSTING_MODE` is locked, `launch_interface.sh` resolves the build mode and runs `start_ros2.sh`, then `start_web_server_and_robot_browser.sh` with that mode. ROS comes up exactly one way regardless of who asked, because there is only one way.

`echo_failure_help` lives in `scripts/lib/teleop_config.sh` and is called when the installation does not validate and when either of those two scripts fails. Since the daemon spawns `launch_interface.sh` itself, a dashboard launch packages the same `stretch4_web_teleop_logs.zip` as a hand-run one, and the non-zero exit reaches `stretch_firebase_daemon.js` either way.

Validation runs before anything is torn down, which matters: `start_ros2.sh` calls `stop_interface.sh`, so a robot with missing certificates would otherwise lose a working stack to a launch that cannot finish.

`start_ros2.sh` is a gate, not merely a step. It tears down any previous stack through `stop_interface.sh`, verifies `rmw_zenohd` actually started, and scans the launch log for errors. Any of those failing stops the launch before bundles are built, so a dead `ROS2` stack can never be reported as a successful launch.

`start_web_server_and_robot_browser.sh` builds the bundles the mode calls for through `build_and_wait_bundles`, waits for them with `waitForBundles.js`, then starts `server.js` and `start_robot_browser.js` under `pm2`. Nothing is written back to the front door: `HOSTING_MODE` cannot change after it is locked, so there is no `<logdir>/hosting_mode` file and no read-back.

`build_and_wait_bundles` is also where `WEB_TELEOP_DIST` is set, next to the build that produces the matching bundle rather than anywhere it could drift from it. There is no longer a separate `WEB_TELEOP_DUAL`: "is the cloud door open" is exactly `WEB_TELEOP_DIST=dist-firebase`, which is the test `start_robot_browser.js` already made. `server.js` derives its mounts and its lease from the same variable.

Because the localstorage bundle is always built with publicPath `/local/`, `dist/` is identical whichever mode produced it and never needs rebuilding because the mode changed. `clear_bundles` remains, for a different reason: a bundle left by an earlier run would satisfy `waitForBundles.js` on sight and pass a build that never ran.

A failed build calls `stop_cloud_mode`, which stays private to this script: it deletes the `pm2` processes it started, the autodeploy watcher included, and clears the bundles. Then it exits 1 in either mode. Neither degrades into the other.

`start_hosting_autodeploy` starts after the bundles exist rather than before, so the watcher never surveys a directory `clear_bundles` has just emptied.

## When a host is unavailable

Four checks run before the stack starts, and they fail differently on purpose.

**`validate_installation`** checks `.env`, `node_modules`, `npm list --depth=0` and the SSL certificates. It gates every launch in every mode, because the certificates are not a per-transport concern: `server.js` reads them with `fs.readFileSync` at module scope, unguarded, so a missing certificate means the robot's HTTPS server never starts — and `start_robot_browser.js` can only load the robot page from loopback, which that same server provides. A robot with broken certificates therefore has no teleop in any hosting mode, Firebase included. There is no `check_local_readiness` and no `local_status`: local hosting has no precondition of its own.

It also runs before the Firebase probe on purpose. `checkFirebaseRobotAccess.js` reports a missing `node_modules` as its own "set up and broken" code, so probing first would blame Firebase for a broken installation.

The **Firebase readiness check** (`check_firebase_readiness`) runs the other three in order and sets `fb_status`. Only the first of them decides that value.

The **signaling preflight** (`scripts/checkFirebaseRobotAccess.js`) signs in with the robot account and reads `assignments/<uid>` — exactly what the robot page does moments later. It is the only check that can veto a cloud host, and `fb_status` is its exit code, which separates a robot that was never set up from one that was set up and has stopped working:

| Exit | Meaning |
| --- | --- |
| `0` | Firebase signaling can work on this robot right now. |
| `2` | No Firebase credentials in `.env`; nobody has ever set this robot up for Firebase. |
| `3` | Credentials are present and something is wrong — the install, the account, the binding, or the network. |

Any other non-zero code is node failing to run the probe, and counts as `3`. Both are fatal to `--firebase`; they differ only in what the error advises. The header of [`checkFirebaseRobotAccess.js`](../scripts/checkFirebaseRobotAccess.js) lists what produces each code.

Since local is the default, this probe runs only when `-f`, `--firebase` or `WEB_TELEOP_HOSTING=firebase` asked for the cloud door. A bare `./launch_interface.sh` never executes it.

It parses `.env` itself instead of through `dotenv`, and requires the Firebase packages only after the credential check passes, so a robot that never touched Firebase exits `2` at once rather than dying on a missing module.

The **hosting preflight** (`check_firebase_host_setup`) checks the Firebase CLI credential, which is separate from the robot account and only uploads builds. It runs only once the signaling preflight has passed. Failing it sets `WEB_TELEOP_AUTODEPLOY=0` and the launch proceeds — it never touches `fb_status`, so a robot can be in `firebase` hosting mode with preview uploads switched off.

The **daemon check** warns when `stretch-web-teleop-daemon.service` is down, because your dashboard cannot start or stop a robot without it. It never vetoes.

Those last two print whatever they have to say straight to the terminal. The probe's own reason is captured into `firebase_error` instead, so the caller can frame it: `2` and `3` are both fatal but want different advice.

`ARG_FIREBASE` exits non-zero on any failure, because the cloud door was asked for by name and is not quietly substituted — and a non-zero exit is how the daemon learns to report the launch as failed rather than claiming success over a robot your dashboard cannot reach.

The same rule applies later, if the build itself fails rather than the preflight.

## Reference: script arguments

| Script | Flag | Argument | Meaning |
| --- | --- | --- | --- |
| `launch_interface.sh` | `-f`, `--firebase` | — | Also open the cloud door. Additive: the LAN door opens either way. With no flag the intent is `ARG_LOCAL`. |
| | `-m` | path to `.yaml` | Map to load. Ignored if the file does not exist. |
| | `-h`, `--help` | — | Show usage. |
| | `-m` | path to `.yaml` | Map, passed to `start_ros2.sh`. |
| | `-l` | directory | Log directory. Defaults to `WEB_TELEOP_LOG_DIR`, then a fresh timestamped one. |
| `start_ros2.sh` | `-l` | directory | Log directory. Ignored if not an existing directory. |
| | `-m` | path to `.yaml` | Map; becomes `map_yaml:=` on the ROS launch. |
| `start_web_server_and_robot_browser.sh` | `--hosting` | `local` or `firebase` | Hosting mode, and so which bundles to build. Defaults to `local`. |
| | `-l` | directory | Log directory, also exported as `REDIRECT_LOGDIR` for `pm2` children. |
| | `-o` | file path | Log file, so parent and child write to the same one. |
| `stop_interface.sh` | — | — | No arguments. |
| `firebase_console_config.sh` | `--install` | — | Create and start the daemon service. |
| | `--refresh` | — | Restart background processes; resets status to standby. |
| | `--deploy` | — | Build production assets and deploy to Firebase. |
| `onboard_firebase_robot.sh` | `--email` | address | Operator to assign this robot to. Prompted for when omitted. |
| | `--non-interactive` | — | Never prompt. Needs `--email` and a logged-in Firebase CLI. |
| | `--skip-daemon` | — | Do the Firebase work only, installing no service. |
| | `-h`, `--help` | — | Show usage. |

## Reference: environment variables

| Variable | Values | Meaning |
| --- | --- | --- |
| `WEB_TELEOP_HOSTING` | `local` or `firebase` | Standing hosting mode, from the environment or `.env`. Any other value is an error, `dual` included. Beaten by `-f`/`--firebase`. Unset means `local`. Since the flag is additive, setting this in the environment is also the only way to force `local` for a single run. |
| `WEB_TELEOP_BUILD_MODE` | `development` or `production` | Watch-and-rebuild, or a one-shot production build. |
| `WEB_TELEOP_LOG_DIR` | directory | Log directory. The daemon sets it so it can tail the whole run. |
| `WEB_TELEOP_AUTODEPLOY` | `0` or `1` | Set to `0` when the Firebase CLI has no usable credential. Skips preview uploads; does not change the hosting mode or `fb_status`. Unset means on, which is what a daemon claim gets. |
| `WEB_TELEOP_DIST` | `dist` or `dist-firebase` | Which bundle `/` serves, and so whether the cloud door is open. `server.js` and `start_robot_browser.js` both derive the mode from it. Set by `build_and_wait_bundles`, not by hand. |
| `WEB_TELEOP_FIREBASE_PROBE_TIMEOUT_MS` | milliseconds, default `15000` | Deadline on the signaling preflight. |
| `WEB_TELEOP_LEASE_TIMEOUT_MS` | milliseconds, default `8000` | Deadline on each teleop-lease call. |
| `WEB_TELEOP_BUILD_TIMEOUT_MS` | milliseconds, default `120000` | How long `waitForBundles.js` waits for bundles. |
| `FIREBASE_TOKEN` | CI token | Lets the hosting preflight pass with no interactive CLI login. |

Intent precedence runs lowest to highest; the last one that applies wins. Default (`local`), then `WEB_TELEOP_HOSTING`, then `-f`/`--firebase`.
Every launch script rejects an unknown flag and takes `-h`/`--help`.

## Shared libraries

These are sourced rather than executed, because the environment they set has to land in the calling shell.

| Library | Provides | Sourced by |
| --- | --- | --- |
| `scripts/lib/teleop_env.sh` | `teleop_setup_env`: `PATH`, `hello-robot.conf`, fleet identity, middleware, workspace overlay | `launch_interface.sh`, `start_ros2.sh`, `scripts/validate_installation.sh` |
| `scripts/lib/teleop_config.sh` | `.env` reading, build-mode resolution, log directory and the `latest_run` symlink, `validate_installation`, `echo_failure_help` | `scripts/validate_installation.sh`, and `launch_interface.sh` by way of `hosting_mode_resolution.sh` |
| `scripts/lib/hosting_mode_resolution.sh` | `hosting_mode_setting`, the `STATUS_*` codes, `check_firebase_readiness`, the hosting preflight and the daemon warning | `launch_interface.sh` |

`scripts/validate_installation.sh` is not a library but a thin wrapper around `validate_installation`, so the check can be run without starting a launch. Nothing in the launch path depends on it — `launch_interface.sh` calls the function directly — but it is the thing to run by hand when a launch is refused, and worth asking for in a support thread:

```bash
./scripts/validate_installation.sh; echo $?
```
