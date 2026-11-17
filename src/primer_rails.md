# Primer: Multi-Rail Hosting and Lobby

When `HOSTING_MODE=firebase` is enabled on a self-hosted Firebase project (`https://<project-id>.web.app`), operators discover and launch robots from a shared **lobby** (`src/pages/home/`) and drive them from the **operator** interface (`src/pages/operator/`). Because the operator browser and the onboard robot peer (`start_robot_peer.py`, `stretch4_web_teleop_robot/`) exchange version-coupled WebRTC commands and telemetry (`src/shared/commands.tsx`, `src/shared/remoterobot.tsx`), a single operator bundle cannot safely drive robots checked out on different software versions.

Firebase Hosting solves this by serving **multiple immutable operator rails** side by side behind a single shared lobby:

1. **Lobby (`/`)** — fleet dashboard built from the repository's GitHub **Latest** release.
1. **Rails (`/r/<tag>/operator/`)** — immutable static operator bundles, one per retained `v*` release tag listed in [`release.json`](../release.json).
1. **Unversioned fallback (`/operator/`)** — built alongside the lobby from **Latest**; used when no stable release exists yet and on single-version preview channels.

Each robot's onboard daemon (`scripts/stretch_firebase_daemon.js`) publishes its git checkout description to Realtime Database (`robots/<fleetId>/build`). The lobby probes `/r/<tag>/manifest.json` on its own origin and routes each robot card's **Connect** action to `/r/<tag>/operator/?robot=<fleetId>`.

## Directory and File Map

```
stretch4_web_teleop/
├── release.json                       # Retained v* release tags published under /r/<tag>/
├── firebase.json                      # Hosting public dir, Cache-Control headers, predeploy gate
├── database.rules.json                # Default-deny RTDB security and schema validation rules
├── webpack.config.js                  # Multi-entry build (--env storage, --env pages, --env rail)
├── scripts/
│   ├── deployHosting.js               # Assembles and publishes live rails or rails-* previews
│   ├── hostingVersion.js              # Firebase Hosting REST API additive clone + upload
│   ├── deployRules.js                 # Diffs live RTDB rules, runs emulator suite, and uploads
│   ├── requireLiveHosting.js          # firebase.json predeploy guard blocking raw CLI deploys
│   ├── releaseTag.js                  # Canonical RELEASE_TAG grammar and buildFromDescribe()
│   ├── stableRail.js                  # Resolves GitHub Latest release tag from git remote origin
│   ├── lobbyManifest.js               # Webpack plugin emitting /lobby.json on lobby-only builds
│   ├── railManifest.js                # Webpack plugin emitting /r/<tag>/manifest.json
│   ├── hostingBundleReady.js          # Build completeness assertions (lobby, rail, whole-site)
│   ├── hostingChannel.js              # Resolves branch-* / local-branch-* preview channel ids
│   ├── firebase_hosting_autodeploy.js # Debounced preview uploader run under PM2 on branches
│   ├── rail_status.sh                 # Probes /r/<tag>/manifest.json for every tag in release.json
│   └── webpackPublicEnv.js            # Allowlist of PUBLIC_* env vars exposed to browser bundles
├── src/pages/home/                    # Fleet lobby / dashboard page
│   └── tsx/
│       ├── index.tsx                  # Auth bootstrap and root render (LoginView / Dashboard)
│       ├── robotModel.ts              # Pure routing, warning, rail-gating, and presence logic
│       ├── useRail.ts                 # /r/<tag>/manifest.json probe, retry, and session cache
│       ├── login_handler/             # FirebaseLoginHandler (RTDB subscriptions) & LocalLoginHandler
│       └── components/                # Dashboard, RobotCard, TeleopButton, BranchTag, sheets
└── test/
    ├── hosting/                       # Offline + Hosting-emulator suites for rails and lobby routing
    └── security/                      # RTDB rules-deploy unit tests + Database-emulator suite
```

## Hosted URL Layout and Caching

Configured in [`firebase.json`](../firebase.json) and enforced by [`webpack.config.js`](../webpack.config.js) and [`scripts/hostingVersion.js`](../scripts/hostingVersion.js):

| Served path | Built from | `Cache-Control` | Purpose |
| --- | --- | --- | --- |
| `/` (`index.html`) | GitHub **Latest** (`npm run build:lobby`) | `no-cache` | Fleet lobby. Only `--env pages=home` emits a root `index.html`. |
| `/lobby.json` | GitHub **Latest** (`LobbyManifestPlugin`) | `no-cache` | Records `{ tag, commit, describe, stable, built }` for the live lobby. |
| `/operator/` | GitHub **Latest** (`npm run build:operator`) | `no-cache` | Unversioned fallback UI and preview-channel entrypoint. |
| `/r/<tag>/` | None | — | `404`. `railBundleReady()` rejects any rail containing `index.html` at `/r/<tag>/index.html`. |
| `/r/<tag>/manifest.json` | Clean `<tag>` checkout (`RailManifestPlugin`) | `no-cache` | Records `{ tag, commit, describe, built }`. Probed by `useRail.ts`, `deployHosting.js`, and `rail_status.sh`. |
| `/r/<tag>/operator/**` and `/r/**/bundle.js` | Clean `<tag>` checkout (`--env rail=<tag>`) | `no-cache` | Versioned operator HTML and entry chunks compiled with `publicPath: "/r/<tag>/"`. |
| `/r/<tag>/<hash>.<ext>` and `**/*.mp4` | Clean `<tag>` checkout | `public, max-age=31536000, immutable` | Content-hashed static assets cached for 1 year. |

Nothing robot-side is built into a rail (`--env rail=<tag>` runs with `--env pages=operator`). The robot side is the robot peer, a Python process that runs only onboard the robot, from whatever tag is checked out there.

## Release Tag Grammar (Three-Way Lockstep)

Every rail tag forms a URL path segment under `/r/<tag>/` and must match:

```text
^v\d+\.\d+\.\d+(-(alpha|beta|rc)\d+)?$
```

Examples: `v0.1.0`, `v0.2.0-alpha1`, `v0.2.0-beta2`, `v1.0.0-rc1` (leading `v` required; no dots inside the pre-release suffix).

This pattern is enforced in **three places that must always be modified together**:

1. [`scripts/releaseTag.js`](../scripts/releaseTag.js) (`RELEASE_TAG`) — daemon build reporting, `release.json` validation, `webpack.config.js`, and `deployHosting.js`.
1. [`database.rules.json`](../database.rules.json) (`robots/$fleetId/build/rail` `.validate` rule) — Realtime Database write validation.
1. [`src/pages/home/tsx/robotModel.ts`](pages/home/tsx/robotModel.ts) (`RAIL` and `PAST_RELEASE`) — client-side lobby routing and warning classification.

## Webpack Multi-Entry and Rail Contract

[`webpack.config.js`](../webpack.config.js) compiles `ALL_PAGES = ["robot", "operator", "home"]` from one configuration parameterized by `--env`:

| Invocation | `--env` flags | Output dir | `publicPath` | Extra manifest |
| --- | --- | --- | --- | --- |
| Local LAN bundle | `storage=localstorage` | `dist/` | `/local/` | None |
| Robot whole-site Firebase bundle | `storage=firebase` | `dist-firebase/` | `/` | None |
| Hosted lobby | `storage=firebase`, `pages=home` | `dist-firebase/` | `/` | `lobby.json` |
| Hosted fallback operator | `storage=firebase`, `pages=operator` | `dist-firebase/` | `/` | None |
| Hosted versioned rail | `storage=firebase`, `pages=operator`, `rail=<tag>` | `dist-firebase/r/<tag>/` | `/r/<tag>/` | `manifest.json` |

Key build constraints for agents editing `webpack.config.js`, `src/pages/operator/`, or `src/pages/home/`:

- **No root-absolute operator asset paths**: Operator code executes under `/local/operator/`, `/operator/`, and `/r/<tag>/operator/`. Import static assets through webpack (`file-loader` / `asset/resource`) or reference `./` relative paths; hardcoded `/operator/...` URLs break on `/local/` and `/r/<tag>/`.
- **Why `LobbyManifestPlugin` runs only on lobby-only builds**: `lobby.json` contains a `built` ISO timestamp. Whole-site dev builds (`npm run firebase`) omit `lobby.json` so [`scripts/firebase_hosting_autodeploy.js`](../scripts/firebase_hosting_autodeploy.js) can SHA-256 hash `dist-firebase/` and skip redundant preview uploads when source files have not changed.
- **Selective output cleaning**: `output.clean` is enabled only when `isProduction && (rail !== null || pages.length === ALL_PAGES.length)` so sequential partial root builds (`build:lobby` followed by `build:operator`) do not wipe each other out of `dist-firebase/`.
- **Public environment allowlist**: Only keys listed in [`scripts/webpackPublicEnv.js`](../scripts/webpackPublicEnv.js) (`PUBLIC_FIREBASE_*`, `PUBLIC_HOSTING_ORIGIN`, `PUBLIC_STABLE_RAIL`, `HELLO_FLEET_ID`) can enter browser bundles. Process environment overrides `.env` so `deployHosting.js` can inject `PUBLIC_HOSTING_ORIGIN` and `PUBLIC_STABLE_RAIL` per build. When `storage === "firebase"` and `!pages.includes("robot")`, `process.env.HELLO_FLEET_ID` is forced to `undefined` because cloud bundles resolve robots per signed-in user.

## Robot Build Identity and Lobby Routing

### How Robots Publish Their Build

In [`scripts/stretch_firebase_daemon.js`](../scripts/stretch_firebase_daemon.js), the systemd service (`stretch-web-teleop-daemon.service`) runs:

```bash
git describe --tags --always --dirty --match "v*"
```

`buildFromDescribe()` in [`scripts/releaseTag.js`](../scripts/releaseTag.js) converts that string and writes `robots/<fleetId>/build` in Realtime Database:

- **Exact clean release tag** (e.g. `v0.2.0`): writes `{ describe: "v0.2.0", rail: "v0.2.0" }`.
- **Commits ahead or dirty tree** (e.g. `v0.2.0-3-g46cf732` or `v0.2.0-dirty`): writes `{ describe: "..." }` with `rail` omitted.
- **No `v*` tag ancestor**: writes `{ describe: "<short-sha>" }` with `rail` omitted.

The daemon reads git state on startup (`initDaemon`) and when executing a `launch` command (`handleLaunchCommand`) — it does **not** watch `.git/` while idle in `standby`. Switching tags on an idle robot requires `./firebase_console_config.sh --refresh` (or launching the interface) before `robots/<fleetId>/build` updates.

### Origin Gate (`servesRails`)

`servesRails()` in [`src/pages/home/tsx/robotModel.ts`](pages/home/tsx/robotModel.ts) returns `true` only when `new URL(process.env.PUBLIC_HOSTING_ORIGIN).origin === window.location.origin`.

- **Live Hosting site (`https://<project-id>.web.app`)**: `servesRails() === true`; cards probe `/r/<tag>/manifest.json` and route to `/r/<tag>/operator/?robot=<id>`.
- **Preview channels (`https://<project-id>--<channel>-<hash>.web.app`) and robot-local cloud server (`https://<robot-ip>/`)**: `servesRails() === false`; every card routes to `/operator/?robot=<id>` with no rail probing and no build mismatch warnings.

### Card Resolution Pipeline

On a live Hosting origin, `RobotCard.tsx` resolves each robot's route and UI state through [`robotModel.ts`](pages/home/tsx/robotModel.ts) and [`useRail.ts`](pages/home/tsx/useRail.ts):

1. **Wanted rail (`railFor`)**: Uses `robot.build.rail` if valid; otherwise extracts the nearest ancestor `v*` tag from `robot.build.describe` (`releaseBehind`, matching `PAST_RELEASE`); otherwise falls back to `PUBLIC_STABLE_RAIL` (`stableRail()`, or `null` if unset).
1. **Manifest probe (`useRailAvailable` / `probeRail`)**: Fetches `/r/<rail>/manifest.json` with `cache: "no-store"`.
   - `200 OK` -> `"deployed"` (cached in-memory for the page session; concurrent cards on the same rail share one in-flight request).
   - `404` or `410` -> `"absent"` (never cached, so a newly published rail resolves on re-render without a hard reload).
   - Network error or `5xx` -> retried once after `1000ms`; if still inconclusive -> `"unknown"`, which resolves `available = true` (fails open on transient network faults rather than falsely claiming a release is undeployed).
1. **Fallback routing (`routedRail`)**: If `wanted` is `"absent"`, falls back to `PUBLIC_STABLE_RAIL` (which is itself probed by a second `useRailAvailable(rail)` call).
1. **Warnings and refusal gates (`buildWarning`, `railNotice`, `railGate`)**:
   - Clean tag deployed -> opens `/r/<tag>/operator/?robot=<id>`, normal tag pill, no warning.
   - Commits or `-dirty` ahead of deployed `<tag>` -> opens `/r/<tag>/operator/?robot=<id>`, red `<describe>` pill, warns `Unreleased changes on <tag> / → Routes to <tag>`.
   - Wanted `<tag>` absent (`404`) -> opens `/r/<stable>/operator/?robot=<id>`, red pill, warns `Release <tag> not deployed / → Defaults to stable (<stable>)`.
   - Untagged history -> opens `/r/<stable>/operator/?robot=<id>`, red pill, warns `Checkout is not a release / → Defaults to stable (<stable>)`.
   - Fallback `<stable>` itself is absent (`404`) -> `railGate` returns `"refused"`, replacing **Start Interface** / **Connect** with `Release <stable> is not deployed` while keeping **Stop Interface** active if the robot is already running.

## Hosting Channels, Additive Deploys, and Guards

### Three Hosting Channel Mechanisms

| Mechanism | Entrypoint | Channel / URL | Serves rails? | Purpose |
| --- | --- | --- | --- | --- |
| Live production site | `npm run deploy:hosting` (clean `v*` tag in `release.json`) | `live` (`https://<project-id>.web.app`) | Yes (`/r/<tag>/operator/`) | Multi-version fleet lobby and immutable release rails. |
| Manual staging preview | `npm run deploy:hosting -- --preview` (any branch, dirty tree, or tag) | `rails-<slug>` (30-day TTL) | No (routes all cards to `/operator/`) | Staging lobby edits or testing a release candidate without touching live rails. |
| Robot watcher autodeploy | `./launch_interface.sh -f` (`firebase_hosting_autodeploy.js`) | `branch-<slug>` or `local-branch-<slug>` (30-day TTL) | No (whole-site `dist-firebase/` upload) | Edit-save-reload loop on an onboarded development robot checked out on a branch. Skipped on detached `HEAD` tags (`hostingChannel.js`). |

### Additive Assembly (`deployHosting.js` + `hostingVersion.js`)

Each Firebase Hosting version is a full site snapshot. [`scripts/deployHosting.js`](../scripts/deployHosting.js) and [`scripts/hostingVersion.js`](../scripts/hostingVersion.js) (`publishAdditively`) avoid rebuilding historical tags on every release:

- **Rail retention (`release.json`)**: `assembleRails()` compiles `/r/<tag>/` from `HEAD` and caches a copy in `.rails-cache/<tag>/` (gitignored). Other tags in `release.json` are copied from `.rails-cache/` if present locally; otherwise `deployHosting.js` verifies `HEAD /r/<rail>/manifest.json` returns `200` on the live site and clones them server-side via the Firebase Hosting REST API `versions:clone` endpoint (`include.regexes: ["^/r/<rail>/.*$"]`). Removing a tag from `release.json` omits it from the clone filter and prunes `/r/<old-tag>/` atomically.
- **`.rails-cache/` overwrite caveat**: `publishAdditively` uploads everything in `dist-firebase/` on top of the server-side clone, while `checkPublishedRail()` checks commit immutability **only for `HEAD`'s own `tag`**. Use `--rail-only` (`npm run deploy:hosting -- --rail-only`) from a clean `<older-tag>` checkout when intentionally populating `.rails-cache/<older-tag>/` (e.g., bootstrapping a new Firebase project); delete `.rails-cache/` if its provenance is uncertain.
- **Lobby rebuild vs. carry (`stableRail.js` + `lobbyPlan`)**: [`scripts/stableRail.js`](../scripts/stableRail.js) parses `<owner>/<repo>` from `git remote get-url origin` and queries `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` (using `GITHUB_TOKEN` when set). On a live deploy:
  - When `tag === stable` (or `liveHasRelease === false` on an empty Firebase project), `/` (`index.html`, `/lobby.json`) and `/operator/` are rebuilt from `HEAD` with `PUBLIC_STABLE_RAIL=stable`.
  - When `tag !== stable` (pre-releases `alpha`/`beta`/`rc`, older patches, or unreleased tags), `carryRoot: true` clones all non-`/r/` paths from the live Hosting version (`^/(r|[^r].*|r[^/].*)$`), leaving `/` and `/operator/` untouched.

### Automated Release and Rules Guards

1. **Clean release tag guard (`checkoutTag`)**: Live deploys require `git status --porcelain` to be completely empty (**including untracked files**) and `HEAD` to match an exact `v*` tag retained in `release.json`. Note: when `--origin` is omitted and `checkoutTag()` returns `tag: null` (branch, modified file, or untracked file), `deployHosting.js` **silently sets `options.preview = true`** (`rails-<slug>`) instead of aborting; passing `--origin https://<project-id>.web.app` forces an immediate error.
1. **Rail immutability guard (`checkPublishedRail`)**: Fetches `/r/<tag>/manifest.json` before building and aborts if `/r/<tag>/` is already live with a different `commit` SHA (unless `--republish` is passed).
1. **Default rail retention guard (`checkCarriedLobby` & `stable` check)**: Aborts live deploys if GitHub **Latest** (`stable`) is omitted from `release.json` (downgraded to a warning under `--dry-run`), and when carrying the live lobby, reads `/lobby.json` and aborts if `lobby.stable` is omitted from `release.json`.
1. **Raw CLI predeploy gate ([`scripts/requireLiveHosting.js`](../scripts/requireLiveHosting.js))**: Registered as `hosting.predeploy` in `firebase.json`. Blocks raw `firebase deploy` / `firebase deploy --only hosting` unless `.firebaserc` matches `PUBLIC_FIREBASE_PROJECT_ID` in `.env`, `HEAD` is a clean tag in `release.json`, and `dist-firebase/` locally contains `index.html`, `operator/index.html`, and **every** rail in `release.json`. Allows `firebase hosting:channel:deploy` once `.firebaserc` matches `.env`.
1. **Database rules deploy gate ([`scripts/deployRules.js`](../scripts/deployRules.js))**: `npm run deploy:rules` syncs `.firebaserc`, fetches the live ruleset, prints a normalized unified diff against `database.rules.json`, requires interactive confirmation (`-- --no-check` for unattended runs), runs `npm run test:firebase-rules` against an ephemeral local Database Emulator, and uploads only on pass.

## Cross-Rail Compatibility and Test Suites

### Shared Plane vs. Versioned Plane

All deployed `/r/<tag>/operator/` rails share **one live Lobby (`/`)** and **one live Realtime Database (`database.rules.json`)**:

- **Must remain backward-compatible across all rails in `release.json`**: `database.rules.json` predicates and RTDB schemas under `uids/<authUid>`, `assignments/<identity>`, `robots/<fleetId>` (`status`, `build`, `branch`, `map_id`, `config`, `control`), `launch_logs/<fleetId>`, `maps/<mapId>`, `rooms/<robotUid>` (SDP/ICE signaling and `scripts/teleopLease.js` seat leases), and `operators/<identity>` (`FirebaseStorageHandler` layouts/poses/recordings). Do not tighten a `.validate` rule in a way that rejects writes from an active older rail until that rail is removed from `release.json`.
- **Alias lookup asymmetry**: When `uids/<authUid>` defines an `<alias>`, `FirebaseLoginHandler.tsx` queries `assignments/<alias>` (and `operators/<identity>` + `rooms/$robotUid/operator/alias` require `<alias>`), whereas `database.rules.json` read/write predicates on `robots`, `launch_logs`, `maps`, and `rooms` accept grants under **either** `assignments/<authUid>` or `assignments/<alias>`.
- **Versioned per rail**: WebRTC data-channel commands (`src/shared/commands.tsx`, `remoterobot.tsx`, `util.tsx`) are paired per `<tag>` between `/r/<tag>/operator/` and a robot cleanly checked out on `<tag>`. Unreleased `cmd` changes must be tested via `/local/operator/`, `https://<robot-ip>/operator/`, or a preview channel (`branch-*` / `rails-*`) before tagging a new rail.

### Test Suites

- **`npm test` / `npm run test:offline`** (runs in CI via `.github/workflows/test.yaml`; needs no credentials or emulators):
  - `test/hosting/hosting-backend.test.mjs` — additive `versions:clone` filters, header conversion, `deployHosting.js` assembly, and `--rail-only`.
  - `test/hosting/release-guards.test.mjs` — `checkoutTag`, immutability, `checkCarriedLobby`, and `requireLiveHosting.js` process-tree checks.
  - `test/hosting/build-identity.test.mjs` — `RELEASE_TAG`, `buildFromDescribe`, `lobbyManifest`, and `railManifest`.
  - `test/hosting/lobby-routing.test.mjs` — `servesRails`, `railFor`, `routedRail`, `useRailAvailable` caching/retry, `buildWarning`, and `railGate`.
  - `test/security/rules-deploy.test.mjs` — `deployRules.js` normalization, diffing, prompt gating, and `--no-check`.
- **`npm run test:emulated`** (starts ephemeral local Firebase Hosting and Database emulators; requires `java` on `PATH`):
  - `test/hosting/hosting-routes.test.mjs` (`runHostingRoutes.mjs`) — end-to-end HTTP status and `Cache-Control` header verification across `/`, `/operator/`, and `/r/<tag>/**`.
  - `test/security/firebase-database-rules.test.mjs` (`runDatabaseRules.mjs`) — **currently covers `robots/$fleetId/build` write/validation rules only**. Agents modifying `database.rules.json` rules for `uids`, `assignments`, `control`, `maps`, `rooms`, or `operators` must add positive and negative test cases to `firebase-database-rules.test.mjs`; passing `npm run deploy:rules` alone will not exercise uncovered paths.
