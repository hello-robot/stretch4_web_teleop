#!/usr/bin/env node

/**
 * deployHosting.js
 *
 * Assemble and publish one Hosting version: the lobby at /, the unversioned
 * operator page at /operator/, and every rail release.json retains.
 *
 * A Hosting version is the complete file set, not a patch, so anything left
 * out of the version is deleted from the site. Only the rail for this
 * checkout's tag is built locally; the rest are restored from .rails-cache/
 * or carried across server-side by cloning the retained /r/<tag>/ trees from
 * the currently live Hosting version.
 *
 * Usage:
 *   node scripts/deployHosting.js                    publish the live site
 *   node scripts/deployHosting.js --preview          publish to rails-<branch|tag>
 *   node scripts/deployHosting.js --tag v0.9.9-rc1   preview a temporary rail
 *   node scripts/deployHosting.js --dry-run          assemble and check only
 *   node scripts/deployHosting.js --rail-only        build and cache this tag's rail
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { execFileSync, spawnSync } = require("child_process");

const { branchSlug } = require("./hostingChannel");
const { isReleaseTag } = require("./releaseTag");
const { stableRail } = require("./stableRail");
const {
    lobbyBundleReady,
    railBundleReady,
} = require("./hostingBundleReady");
const {
    publishAdditively,
    servedAt,
    siteFromOrigin,
} = require("./hostingVersion");
const { syncFirebaseRc, envProjectId } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

/** How child output is handled: streamed, or captured to a file. */
const childOutput = { verbose: false, file: null };

// Same palette and marks the launch scripts use, so a release reads like an
// installation check. Actions renders ANSI without being a terminal.
const COLOUR =
    !process.env.NO_COLOR && Boolean(process.stdout.isTTY || process.env.CI);
const RED = COLOUR ? "\x1b[0;31m" : "";
const GREEN = COLOUR ? "\x1b[0;32m" : "";
const NC = COLOUR ? "\x1b[0m" : "";

/**
 * Report a check that passed.
 *
 * The requirement is coloured and the values it was decided on sit plainly
 * beneath it, so a run can be skimmed for the marks or read for the evidence.
 *
 * @param {string} message The requirement that held.
 * @param {string} [detail] The values it held for.
 * @returns {void}
 */
function pass(message, detail) {
    console.log(`${GREEN}\u2713 ${message}${NC}`);
    if (detail) console.log(`    ${detail}`);
}

/**
 * Report something true and unwelcome that does not stop the release.
 *
 * @param {string} message The condition.
 * @param {string[]} [detail] Lines to indent beneath it.
 * @returns {void}
 */
function warn(message, detail = []) {
    console.warn(`${RED}WARNING:${NC} ${message}`);
    for (const line of detail) console.warn(`         ${line}`);
}

/** Lines of a failed step to print, so the reason is on screen either way. */
const FAILURE_TAIL = 40;

/** Where every other part of the project writes its logs. */
const TELEOP_LOG_ROOT = path.join(
    os.homedir(),
    "stretch_user",
    "log",
    "web_teleop",
);

/**
 * Path for this run's build output.
 *
 * Timestamped per run and kept, because the build output is the record of what
 * a release actually compiled. The stamp matches the launch directories beside
 * it, to the second.
 *
 * @returns {string} Absolute path to this run's log file.
 */
function defaultLogPath() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return path.join(TELEOP_LOG_ROOT, `release_${stamp}.log`);
}

/**
 * Create the log file and repoint release_latest.log at it.
 *
 * The symlink mirrors the latest_run convention the launch scripts follow, so
 * `tail -f` works without knowing this run's stamp.
 *
 * @param {string} logFile Path to this run's log.
 * @returns {void}
 */
function openLog(logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "");
    const latest = path.join(path.dirname(logFile), "release_latest.log");
    try {
        fs.rmSync(latest, { force: true });
        fs.symlinkSync(logFile, latest);
    } catch {
        // A log that cannot be symlinked is still a log.
    }
}

/**
 * Read a git value, or null when git cannot answer.
 *
 * @param {string[]} args Arguments to git.
 * @returns {string|null} Trimmed stdout, or null.
 */
function git(args) {
    try {
        return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * Run a command, failing the release when it does.
 *
 * Webpack and the Firebase CLI together produce thousands of lines, which bury
 * the few that say what is being released. Their output goes to the log file
 * instead; on failure the tail is printed, so a broken build still explains
 * itself without the log having to be opened.
 *
 * Strips npm_config_dry_run and npm_config_preview from the child environment
 * so an unseparated `npm run deploy:hosting --dry-run` does not prevent child
 * `npm run build:*` commands from emitting bundles.
 *
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments.
 * @param {Record<string, string>} [extraEnv] Extra environment entries.
 * @returns {void}
 * @throws {Error} When the command exits non-zero.
 */
function run(command, args, extraEnv) {
    const label = `${path.basename(command)} ${args.join(" ")}`;
    const {
        npm_config_dry_run: _dryRun,
        npm_config_preview: _preview,
        npm_config_rail_only: _railOnly,
        ...baseEnv
    } = process.env;
    const env = { ...baseEnv, ...extraEnv };

    if (childOutput.verbose) {
        const streamed = spawnSync(command, args, {
            cwd: repoRoot,
            stdio: "inherit",
            env,
        });
        if (streamed.status !== 0) throw new Error(`${label} failed`);
        return;
    }

    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env,
    });
    const captured = `$ ${label}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`;
    fs.appendFileSync(childOutput.file, captured);
    if (result.status !== 0) {
        const tail = captured.trimEnd().split("\n").slice(-FAILURE_TAIL);
        console.error(tail.map((line) => `[RELEASE] | ${line}`).join("\n"));
        throw new Error(`${label} failed; full output in ${childOutput.file}`);
    }
}

/**
 * Check whether npm exported a boolean flag into process.env when the caller
 * omitted `--` before the flag.
 *
 * @param {string} name Environment variable name (e.g. npm_config_dry_run).
 * @returns {boolean} True when set and not "false".
 */
function npmConfigFlag(name) {
    const val = process.env[name];
    return Boolean(val) && val !== "false";
}

/**
 * Parse the command line.
 *
 * Accepts `--dry-run` (with `--skip-deploy` retained as a compatibility alias),
 * `--preview`, and `--rail-only`, and also checks `npm_config_*` environment
 * variables so omitting `--` on `npm run deploy:hosting --dry-run` or
 * `--preview` still honours the flag instead of publishing live.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{preview: boolean, tag: string|null, cache: string,
 *     origin: string|null, dryRun: boolean, railOnly: boolean,
 *     log: string, verbose: boolean, republish: boolean, site: string|null}}
 *     Parsed options.
 */
function parseArgs(argv) {
    const options = {
        preview: npmConfigFlag("npm_config_preview"),
        tag: null,
        cache: path.join(repoRoot, ".rails-cache"),
        origin: null,
        dryRun:
            npmConfigFlag("npm_config_dry_run") ||
            npmConfigFlag("npm_config_skip_deploy"),
        railOnly: npmConfigFlag("npm_config_rail_only"),
        log: defaultLogPath(),
        verbose: false,
        republish: false,
        site: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--dry-run" || arg === "--skip-deploy") {
            options.dryRun = true;
        } else if (arg === "--preview") {
            options.preview = true;
        } else if (arg === "--rail-only") {
            options.railOnly = true;
        } else if (arg === "--tag") {
            options.tag = argv[++i];
        } else if (arg === "--cache") {
            options.cache = path.resolve(argv[++i]);
        } else if (arg === "--origin") {
            options.origin = argv[++i];
        } else if (arg === "--log") {
            options.log = path.resolve(argv[++i]);
        } else if (arg === "--verbose") {
            options.verbose = true;
        } else if (arg === "--republish") {
            options.republish = true;
        } else if (arg === "--site") {
            options.site = argv[++i];
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

/**
 * The rail this run builds, and what it was really built from.
 *
 * Normally the checkout names its own rail: a clean tree on a release tag
 * publishes that release, and the bytes correspond to a commit anyone can
 * check out. --tag overrides the name, which is how a branch gets a routable
 * rail to test with; builtFrom then records the checkout, as does the rail's
 * manifest, and the caller confines it to a preview channel.
 *
 * A checkout that names no rail is not an error here. A preview serves one
 * interface under no release name and needs none, so the tag comes back null
 * and the caller decides whether this run required one.
 *
 * @param {string|null} requested Tag named with --tag, if any.
 * @returns {{tag: string|null, builtFrom: string|null}} The rail name or null,
 *     and the describe it was built from when that is not the tag itself.
 * @throws {Error} When --tag names something that is not a release tag.
 */
function checkoutTag(requested) {
    const dirty = git(["status", "--porcelain"]) !== "";
    const tag = git(["describe", "--tags", "--exact-match", "--match", "v*"]);
    const describe =
        git(["describe", "--tags", "--always", "--dirty", "--match", "v*"]) ??
        "(git cannot answer)";

    // The ordinary case: this checkout is a release, so it names its own rail.
    if (!dirty && isReleaseTag(tag) && (!requested || requested === tag)) {
        return { tag, builtFrom: null };
    }

    if (!requested) {
        return { tag: null, builtFrom: describe };
    }
    if (!isReleaseTag(requested)) {
        throw new Error(`--tag ${requested} is not a release tag`);
    }
    return { tag: requested, builtFrom: describe };
}

/**
 * Rails this release keeps deployed.
 *
 * @returns {string[]} Tags listed in release.json.
 * @throws {Error} When the file is missing or names a non-release tag.
 */
function retainedRails() {
    const file = path.join(repoRoot, "release.json");
    const rails = JSON.parse(fs.readFileSync(file, "utf8")).rails;
    if (!Array.isArray(rails) || rails.length === 0) {
        throw new Error("release.json lists no rails");
    }
    const bad = rails.filter((tag) => !isReleaseTag(tag));
    if (bad.length > 0) {
        throw new Error(`release.json: not release tags: ${bad.join(", ")}`);
    }
    return rails;
}

/**
 * Configured live Hosting origin from process.env or .env, if present.
 *
 * @returns {string|null} The live origin, or null when unset.
 */
function configuredLiveOrigin() {
    return (
        process.env.PUBLIC_HOSTING_ORIGIN ||
        (dotenv.config({ path: path.join(repoRoot, ".env") }).parsed || {})
            .PUBLIC_HOSTING_ORIGIN ||
        null
    );
}

/**
 * Origin the lobby will be served from, which decides whether it routes to
 * rails at all.
 *
 * A preview channel has its own origin, so the channel is created before the
 * build rather than after, and its URL is baked into the lobby.
 *
 * @param {{channel: string|null, origin: string|null}} options Channel and origin options.
 * @returns {string} The origin to build the lobby against.
 * @throws {Error} When no origin can be resolved.
 */
function resolveOrigin(options) {
    if (options.origin) return options.origin;
    if (!options.channel) {
        const fromEnv = configuredLiveOrigin();
        if (!fromEnv) {
            throw new Error(
                "PUBLIC_HOSTING_ORIGIN is not set; the lobby would serve no rails",
            );
        }
        return fromEnv;
    }

    const project = ["--project", envProjectId()];
    const listed = spawnSync(
        firebaseBin,
        ["hosting:channel:list", "--json", ...project],
        { cwd: repoRoot, encoding: "utf8" },
    );
    const channels =
        JSON.parse(listed.stdout || "{}").result?.channels ?? [];
    const existing = channels.find(
        (channel) => channel.name.split("/").pop() === options.channel,
    );
    if (existing) return new URL(existing.url).origin;

    const created = spawnSync(
        firebaseBin,
        [
            "hosting:channel:create",
            options.channel,
            "--expires",
            "30d",
            "--json",
            ...project,
        ],
        { cwd: repoRoot, encoding: "utf8" },
    );
    let url;
    try {
        url = JSON.parse(created.stdout || "{}").result?.url;
    } catch {
        url = undefined;
    }
    if (!url) {
        // The CLI reports credential and project problems on either stream,
        // and an empty message here is the least useful thing it could say.
        const said = `${created.stdout ?? ""}${created.stderr ?? ""}`.trim();
        throw new Error(
            `could not open preview channel ${options.channel}.\n` +
                (said
                    ? said
                          .split("\n")
                          .map((line) => `          ${line}`)
                          .join("\n")
                    : "          The Firebase CLI said nothing; check that it is " +
                      "authenticated (firebase login --reauth)."),
        );
    }
    return new URL(url).origin;
}

/**
 * Preview channel for this checkout, derived rather than invented.
 *
 * One channel per branch, reused across runs, the same habit hostingChannel.js
 * follows. The rails- prefix keeps it clear of the branch- channels a robot's
 * autodeploy owns: those carry a whole-site build and this carries a lobby and
 * a rails tree, so sharing a name would have them overwrite each other.
 *
 * A tag checkout has no branch, so it names the channel instead, which is how
 * a release is staged for inspection with --preview before it goes live.
 *
 * @returns {string} A channel id Hosting will accept.
 */
function previewChannelId() {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const name =
        branch && branch !== "HEAD"
            ? branch
            : (git(["describe", "--tags", "--exact-match", "--match", "v*"]) ??
              git(["rev-parse", "--short", "HEAD"]) ??
              "unknown");
    // Hosting ids are letters, numbers, hyphens and underscores, so the dots a
    // tag carries are folded the way branchSlug folds slashes.
    return `rails-${branchSlug(name).replace(/\./g, "-")}`.slice(0, 63);
}

/**
 * Whether an origin belongs to a preview channel rather than the live site.
 *
 * Hosting gives a channel its own subdomain, site--channel-hash.web.app, so a
 * doubled hyphen in the hostname is what separates one from the live site. An
 * origin resolved from --preview came from the channel API itself and needs no
 * guessing.
 *
 * @param {string} origin Origin the lobby is built against.
 * @param {string|null} channel Derived preview channel id, if any.
 * @returns {boolean} True when nothing published here reaches the live site.
 */
function isPreviewOrigin(origin, channel) {
    if (channel) return true;
    try {
        return new URL(origin).hostname.includes("--");
    } catch {
        return false;
    }
}

/**
 * The manifest of a rail already published at this origin.
 *
 * A rail is immutable, so republishing one from a different commit contradicts
 * whatever was served under that name before. Three answers, and they mean
 * different things: the manifest, null when nothing is published there yet,
 * and undefined when the origin could not be read at all.
 *
 * @param {string} origin Origin to look on.
 * @param {string} tag Rail to look for.
 * @returns {Promise<object|null|undefined>} Manifest, null, or undefined.
 */
async function publishedManifest(origin, tag) {
    try {
        const response = await fetch(`${origin}/r/${tag}/manifest.json`, {
            cache: "no-store",
        });
        if (response.status === 404) return null;
        if (!response.ok) return undefined;
        return await response.json();
    } catch {
        return undefined;
    }
}

/**
 * Compare what is published under this rail's name with what is about to be.
 *
 * Off a preview channel a mismatch is fatal: the name is taken by a different
 * commit, and a rail that changes under a fixed name is the one thing the
 * whole scheme rules out. On a preview channel rebuilding is the point, so it
 * reports and continues.
 *
 * @param {string} origin Origin the lobby is built against.
 * @param {string} tag Rail being built.
 * @param {string|null} channel Preview channel id, if any.
 * @param {boolean} republish Whether a known mismatch was accepted.
 * @returns {Promise<void>} Resolves when the rail may be published.
 * @throws {Error} When the name is taken by a different commit.
 */
async function checkPublishedRail(origin, tag, channel, republish) {
    const head = git(["rev-parse", "HEAD"]);
    const published = await publishedManifest(origin, tag);

    if (published === undefined) {
        console.log("- Rail name unused at this origin: not checked");
        console.log(
            `    /r/${tag}/manifest.json could not be read at this origin`,
        );
        return;
    }
    if (published === null) {
        pass("Rail name unused at this origin", `/r/${tag}/ is not published`);
        return;
    }
    if (published.commit === head) {
        pass(
            "Published rail matches this build",
            `/r/${tag}/ already serves ${head}`,
        );
        return;
    }

    const detail =
        `/r/${tag}/ is published from ${published.commit ?? "an unrecorded commit"}` +
        `, and this build is ${head}.`;
    if (isPreviewOrigin(origin, channel) || republish) {
        warn(detail, ["The rail under that name is about to change content."]);
        return;
    }
    throw new Error(
        `${detail}\n` +
            "          A rail is immutable, so publishing would change what " +
            "that name has already served.\n" +
            "          Check the tag out again, or pass --republish if the " +
            "published rail is known to be wrong.",
    );
}

/**
 * Build the lobby into a cleared dist-firebase.
 *
 * PUBLIC_HOSTING_ORIGIN is the origin the lobby compares location.origin
 * against to decide whether it routes to rails at all. A preview channel
 * serves one build, so it is deliberately not handed its own origin here: the
 * comparison fails there, every card routes to the unversioned /operator/
 * page, and rails stay a property of the live site alone. The stable release
 * is withheld for the same reason, since nothing on a preview can route to it.
 *
 * @param {string} origin Origin the lobby is served from.
 * @param {string|null} stable Stable release tag, or null for none.
 * @param {boolean} [preview=false] True when this version goes to a preview
 *     channel rather than the live site.
 * @returns {void}
 */
function buildLobby(origin, stable, preview = false) {
    const railsOrigin = preview ? configuredLiveOrigin() : origin;
    fs.rmSync(distDir, { recursive: true, force: true });
    run("npm", ["run", "build:lobby"], {
        ...(railsOrigin ? { PUBLIC_HOSTING_ORIGIN: railsOrigin } : {}),
        ...(stable && !preview ? { PUBLIC_STABLE_RAIL: stable } : {}),
    });
    if (!lobbyBundleReady(distDir)) {
        throw new Error("lobby build produced no root index.html");
    }
}

/**
 * Build the unversioned /operator/ page beside the lobby.
 *
 * It is not a rail and not the lobby, but every card links there while no
 * stable release is set, and a version that omits it deletes the page the
 * whole fleet is pointed at.
 *
 * @param {string} origin Origin the page is served from.
 * @param {string|null} stable Stable release tag, or null for none.
 * @returns {void}
 * @throws {Error} When the page is missing afterwards.
 */
function buildFallbackOperator(origin, stable) {
    run("npm", ["run", "build:operator"], {
        PUBLIC_HOSTING_ORIGIN: origin,
        ...(stable ? { PUBLIC_STABLE_RAIL: stable } : {}),
    });
    if (!fs.existsSync(path.join(distDir, "operator", "index.html"))) {
        throw new Error("fallback build produced no /operator/index.html");
    }
}

/**
 * Build and cache a single release rail without building the lobby or
 * consulting GitHub's latest release.
 *
 * Used to populate .rails-cache/<tag> from an older release tag checkout whose
 * historical release.json predates newer releases.
 *
 * @param {string} tag Clean release tag checked out at HEAD.
 * @param {string} cacheDir Directory of cached rails.
 * @returns {void}
 */
function buildRailOnly(tag, cacheDir) {
    const target = path.join(distDir, "r", tag);
    fs.rmSync(target, { recursive: true, force: true });
    run("npm", ["run", "build:operator", "--", "--env", `rail=${tag}`]);
    if (!railBundleReady(target)) {
        throw new Error(`rail ${tag} is incomplete at ${target}`);
    }
    const cached = path.join(cacheDir, tag);
    fs.rmSync(cached, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.cpSync(target, cached, { recursive: true });
}

/**
 * Put every retained rail it can into the assembled tree.
 *
 * The rail for this checkout's tag is built; the others are copied from the
 * cache, because a rail is immutable and rebuilding one would need its own
 * checkout and its own node_modules -- and an old tag predates the rail
 * support entirely, so it cannot build itself as one.
 *
 * Temporary rails (built off a branch or dirty tree with --tag) are never
 * written into .rails-cache/, so a branch build cannot overwrite a cached
 * release tag.
 *
 * @param {string[]} rails Tags to assemble.
 * @param {string} tag Tag this checkout builds.
 * @param {string} cacheDir Directory of previously built rails.
 * @param {boolean} [temporary=false] True when built from a non-tag checkout.
 * @returns {{assembled: string[], missing: string[]}} What landed, and what
 *     had no local copy to land from.
 * @throws {Error} When a rail is present but incomplete.
 */
function assembleRails(rails, tag, cacheDir, temporary = false) {
    const assembled = [];
    const missing = [];
    for (const rail of rails) {
        const target = path.join(distDir, "r", rail);
        if (rail === tag) {
            // The same operator build; --env rail moves it under r/<tag>/ and
            // points its assets there.
            run("npm", [
                "run",
                "build:operator",
                "--",
                "--env",
                `rail=${rail}`,
            ]);
            if (!temporary) {
                fs.rmSync(path.join(cacheDir, rail), {
                    recursive: true,
                    force: true,
                });
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.cpSync(target, path.join(cacheDir, rail), {
                    recursive: true,
                });
            }
        } else {
            const cached = path.join(cacheDir, rail);
            if (!fs.existsSync(cached)) {
                missing.push(rail);
                continue;
            }
            fs.cpSync(cached, target, { recursive: true });
        }
        if (!railBundleReady(target)) {
            throw new Error(`rail ${rail} is incomplete at ${target}`);
        }
        assembled.push(rail);
    }
    return { assembled, missing };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    childOutput.verbose = options.verbose;
    childOutput.file = options.log;
    if (!options.verbose) openLog(options.log);

    const { tag, builtFrom } = checkoutTag(options.tag);
    const temporary = Boolean(builtFrom);

    if (options.railOnly) {
        if (temporary) {
            throw new Error(
                `--rail-only requires a clean checkout of a release tag (current checkout: ${builtFrom})`,
            );
        }
        console.log(`Building and caching rail ${tag} only`);
        if (!options.verbose) {
            console.log(`  build log   ${options.log}`);
            console.log("");
        }
        buildRailOnly(tag, options.cache);
        pass(
            "Rail built and cached",
            `${tag} -> ${path.join(options.cache, tag)}`,
        );
        return;
    }

    syncFirebaseRc(envProjectId());

    // A non-tag build always targets a preview channel unless --dry-run was
    // given with an explicit preview --origin.
    if (temporary && !options.preview && !options.origin) {
        options.preview = true;
    }
    const channel = options.preview ? previewChannelId() : null;

    // The CLI is only consulted to resolve a preview channel's origin when no
    // explicit --origin was supplied.
    const needsCli = (Boolean(channel) && !options.origin) || !options.dryRun;
    if (needsCli && !envProjectId()) {
        throw new Error(
            "no Firebase project: set PUBLIC_FIREBASE_PROJECT_ID in .env.\n" +
                "          Assembling without one needs --dry-run and an " +
                "explicit --origin.",
        );
    }
    const origin = resolveOrigin({ channel, origin: options.origin });
    const preview = isPreviewOrigin(origin, channel);
    const publishingLive = !channel && !preview && !options.dryRun;

    // Rails exist so one live site can serve a fleet spread across releases. A
    // preview channel carries a single build of a single branch, so it reads
    // no release.json, keeps no rails, and publishes none.
    const rails = preview ? [] : retainedRails();

    // Everything off a preview serves a rail, and a rail must be named after a
    // release. A preview serves one interface at /operator/ and names nothing.
    if (!preview && !tag) {
        throw new Error(
            `this checkout is not a release: ${builtFrom}\n` +
                "          Check out a release tag to publish it, or pass " +
                "--tag <release> to build a\n" +
                "          temporary rail under that name. A preview needs " +
                "neither.",
        );
    }

    // A rail whose contents do not match its name is temporary. It may never
    // be published to the live site, and even on a dry run it may not use a
    // retained release name against the live origin.
    if (temporary && !preview) {
        if (!options.dryRun || rails.includes(tag)) {
            throw new Error(
                `--tag ${tag} would build a rail from ${builtFrom}, and ${
                    rails.includes(tag)
                        ? `${tag} is a supported release`
                        : "the target is the live site"
                }.\n` +
                    "          Publishing a branch build to the live site would " +
                    "overwrite production with commits no tag reproduces.\n" +
                    "          Pass --preview (or omit --origin) to deploy to " +
                    `preview channel ${previewChannelId()}, or check out ${tag} cleanly.`,
            );
        }
    }
    if (!temporary && !rails.includes(tag) && !preview) {
        throw new Error(
            `release.json does not retain ${tag}; add it first, or pass --preview`,
        );
    }

    // A preview assembles no rails at all. Off a preview this checkout's rail
    // rides alongside the kept set rather than replacing it, whether it was
    // built from a tag or from a branch: a dry run may legitimately assemble a
    // tag release.json does not retain.
    const assembling = preview
        ? []
        : rails.includes(tag)
          ? rails
          : [...rails, tag];

    const site = channel
        ? `${origin} (preview channel ${channel})`
        : `${origin} (${preview ? "a preview channel" : "the live site"})`;

    /**
     * One row of the what-and-where table.
     *
     * @param {string} label Which artifact.
     * @param {string} value What it was built from, or its name.
     * @param {string} [servedPath] Path it is served at, when it has one.
     * @returns {void}
     */
    const row = (label, value, servedPath) =>
        console.log(
            `  ${label.padEnd(12)}${servedPath ? value.padEnd(34) + "->  " + servedPath : value}`,
        );

    console.log(
        options.dryRun ? `Assembling only, for ${site}` : `Deploying to ${site}`,
    );
    row("lobby", builtFrom ?? tag, "/");
    if (preview) {
        row("interface", builtFrom ?? tag, "/operator/");
        row("rails", "none (a preview serves one build)");
    } else {
        row("rail", `${tag}${temporary ? " (temporary)" : ""}`, `/r/${tag}/`);
        row("rails kept", rails.join(", "));
    }
    if (!options.verbose) row("build log", options.log);
    console.log("");

    if (preview) {
        pass(
            "Preview publishes one interface, under no release name",
            `${builtFrom ?? tag} -> /operator/`,
        );
    } else if (temporary) {
        pass(
            "Temporary rail targets a preview build",
            `${tag} from ${builtFrom}`,
        );
    } else {
        pass(
            "Release tag listed in supported rails",
            `${tag} in [${rails.join(", ")}]`,
        );
    }

    // The stable release decides which rail a robot reporting none falls back
    // to. A preview routes every card to /operator/, so it has nothing to ask
    // GitHub about.
    const stable = preview ? null : await stableRail(repoRoot);
    if (preview) {
        pass(
            "Preview does not consult the fleet's stable release",
            "every card there opens /operator/",
        );
    } else if (stable) {
        pass("Default rail taken from the latest GitHub release", stable);
        if (!rails.includes(stable)) {
            if (publishingLive) {
                throw new Error(
                    `stable release ${stable} is not retained in release.json`,
                );
            }
            warn(`stable release ${stable} is not retained in release.json`, [
                "Continuing because this run is not publishing to the live channel.",
            ]);
        } else {
            pass(
                "Default rail listed in supported rails",
                `${stable} in [${rails.join(", ")}]`,
            );
        }
    } else {
        pass(
            "No GitHub release is published",
            "robots reporting no rail keep the unversioned page",
        );
    }

    if (!preview) {
        if (temporary) {
            warn(
                `rail ${tag} is built from ${builtFrom}, not from a release.`,
                [
                    "Its manifest.json records that. It is not cached in .rails-cache/",
                    "and is not retained by release.json.",
                ],
            );
        } else {
            pass("Rail built from its own release tag", tag);
        }
        // A rail is immutable, so its name may not change hands. A preview
        // publishes no rail, and rebuilding a branch is the whole point.
        await checkPublishedRail(origin, tag, channel, options.republish);
    }

    buildLobby(origin, stable, preview);
    pass("Lobby emits the only page at the root", "index.html");
    buildFallbackOperator(origin, stable);
    pass(
        "Unversioned operator page assembled",
        "/operator/ (where cards link while no rail resolves)",
    );
    const { assembled, missing } = assembleRails(
        assembling,
        tag,
        options.cache,
        temporary,
    );

    // Both live and preview publishes clone retained rails from the live
    // Hosting version when one exists, so a rail this run did not assemble
    // survives as long as the live site already serves it.
    if (missing.length > 0 && !options.dryRun) {
        const inferredSite =
            options.site ?? siteFromOrigin(origin) ?? envProjectId();
        const liveOrigin =
            configuredLiveOrigin() ??
            (inferredSite ? `https://${inferredSite}.web.app` : origin);
        const absent = [];
        for (const rail of missing) {
            if (!(await servedAt(liveOrigin, `/r/${rail}/manifest.json`))) {
                absent.push(rail);
            }
        }
        if (absent.length > 0) {
            if (publishingLive) {
                throw new Error(
                    `retained, not assembled here, and not on the site: ${absent.join(", ")}.\n` +
                        "          Nothing would carry them across, so publishing " +
                        "would drop them.\n" +
                        "          Check each tag out and run this with " +
                        "--rail-only to build it, or\n" +
                        "          drop it from release.json.",
                );
            }
            warn(
                `retained rails not in .rails-cache/ or on live site: ${absent.join(", ")}`,
                ["Preview channel will not serve them until they are built."],
            );
        } else {
            pass(
                "Rails not built here are already on the live site",
                `${missing.join(", ")} (carried across by the clone)`,
            );
        }
    } else if (missing.length > 0) {
        warn(`not assembled, no cached copy: ${missing.join(", ")}`, [
            "Nothing here is pinned to them.",
        ]);
    }
    pass("Rails assembled and complete", assembled.join(", ") || "none");

    if (options.dryRun) {
        pass("Release assembled; dry run complete (nothing deployed)");
        return;
    }

    await publishAdditively({
        origin,
        distDir,
        site: options.site,
        retainedRails: rails,
        channel: channel ?? "live",
        report: pass,
    });
}

module.exports = {
    isPreviewOrigin,
    parseArgs,
    previewChannelId,
    publishedManifest,
    checkPublishedRail,
};

// Guarded so the helpers above can be required without running a release.
if (require.main === module) {
    main().catch((error) => {
        console.error(`${RED}ERROR:${NC} ${error.message}`);
        process.exit(1);
    });
}
