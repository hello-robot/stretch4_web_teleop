#!/usr/bin/env node

/**
 * releaseRail.js
 *
 * Assemble and publish one Hosting version: the lobby, plus every rail that
 * release.json retains.
 *
 * A Hosting version is the complete file set, not a patch, so a rail left out
 * of the upload is a rail deleted. Only the rail for this checkout's tag is
 * built; the rest are restored from the cache directory an earlier release
 * left behind, which is what CI caches between runs.
 *
 * Usage:
 *   node scripts/releaseRail.js --skip-deploy      assemble and check only
 *   node scripts/releaseRail.js --channel rails-test
 *   node scripts/releaseRail.js                    publish the live site
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { execFileSync, spawnSync } = require("child_process");

const { isReleaseTag } = require("./releaseTag");
const { stableRail } = require("./stableRail");
const { lobbyBundleReady, railBundleReady } = require("./hostingBundleReady");
const { syncFirebaseRc, envProjectId } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

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
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments.
 * @param {Record<string, string>} [extraEnv] Extra environment entries.
 * @returns {void}
 */
function run(command, args, extraEnv) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, ...extraEnv },
    });
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} ${args.join(" ")} failed`);
    }
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{channel: string|null, tag: string|null, cache: string,
 *     origin: string|null, skipDeploy: boolean}} Parsed options.
 */
function parseArgs(argv) {
    const options = {
        channel: null,
        tag: null,
        cache: path.join(repoRoot, ".rails-cache"),
        origin: null,
        skipDeploy: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--skip-deploy") options.skipDeploy = true;
        else if (arg === "--channel") options.channel = argv[++i];
        else if (arg === "--tag") options.tag = argv[++i];
        else if (arg === "--cache") options.cache = path.resolve(argv[++i]);
        else if (arg === "--origin") options.origin = argv[++i];
        else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

/**
 * The tag to build a rail for.
 *
 * A live release is built from a clean tag, so the published bytes correspond
 * to a commit anyone can check out. A preview channel is for looking at work
 * in progress, so it accepts --tag on any checkout and says so; the rail's
 * manifest still records the real describe.
 *
 * @param {string|null} requested Tag named with --tag, if any.
 * @param {boolean} live Whether this run publishes the live site.
 * @returns {string} The tag to build a rail for.
 * @throws {Error} When a live release is not a clean release checkout.
 */
function checkoutTag(requested, live) {
    const dirty = git(["status", "--porcelain"]) !== "";
    const tag = git(["describe", "--tags", "--exact-match", "--match", "v*"]);

    if (!live) {
        if (requested && isReleaseTag(requested)) {
            if (requested !== tag || dirty) {
                console.warn(
                    `[RELEASE] building rail ${requested} from a checkout that ` +
                        "is not that tag; preview only",
                );
            }
            return requested;
        }
        if (isReleaseTag(tag)) return tag;
        throw new Error(
            "no release tag here; name one with --tag for a preview build",
        );
    }

    if (dirty) {
        throw new Error("working tree is dirty; a release must be a clean tag");
    }
    if (!isReleaseTag(tag)) {
        throw new Error(
            "HEAD is not a release tag. Check one out: git checkout v0.1.0",
        );
    }
    if (requested && requested !== tag) {
        throw new Error(`--tag ${requested} but this checkout is ${tag}`);
    }
    return tag;
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
 * Origin the lobby will be served from, which decides whether it routes to
 * rails at all.
 *
 * A preview channel has its own origin, so the channel is created before the
 * build rather than after, and its URL is baked into the lobby.
 *
 * @param {{channel: string|null, origin: string|null}} options Parsed options.
 * @returns {string} The origin to build the lobby against.
 * @throws {Error} When no origin can be resolved.
 */
function resolveOrigin(options) {
    if (options.origin) return options.origin;
    if (!options.channel) {
        const fromEnv =
            process.env.PUBLIC_HOSTING_ORIGIN ||
            (dotenv.config({ path: path.join(repoRoot, ".env") }).parsed || {})
                .PUBLIC_HOSTING_ORIGIN;
        if (!fromEnv) {
            throw new Error(
                "PUBLIC_HOSTING_ORIGIN is not set; the lobby would serve no rails",
            );
        }
        return fromEnv;
    }

    const listed = spawnSync(
        firebaseBin,
        ["hosting:channel:list", "--json"],
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
        ["hosting:channel:create", options.channel, "--expires", "30d", "--json"],
        { cwd: repoRoot, encoding: "utf8" },
    );
    const url = JSON.parse(created.stdout || "{}").result?.url;
    if (!url) {
        throw new Error(
            `could not create preview channel ${options.channel}:\n${created.stderr}`,
        );
    }
    return new URL(url).origin;
}

/**
 * Build the lobby into a cleared dist-firebase.
 *
 * @param {string} origin Origin the lobby is served from.
 * @param {string|null} stable Stable release tag, or null for none.
 * @returns {void}
 */
function buildLobby(origin, stable) {
    fs.rmSync(distDir, { recursive: true, force: true });
    run("npm", ["run", "build:lobby"], {
        PUBLIC_HOSTING_ORIGIN: origin,
        ...(stable ? { PUBLIC_STABLE_RAIL: stable } : {}),
    });
    if (!lobbyBundleReady(distDir)) {
        throw new Error("lobby build produced no root index.html");
    }
}

/**
 * Put every retained rail into the assembled tree.
 *
 * The rail for this checkout's tag is built; the others are copied from the
 * cache, because a rail is immutable and rebuilding one would need its own
 * checkout and its own node_modules.
 *
 * @param {string[]} rails Tags to assemble.
 * @param {string} tag Tag this checkout builds.
 * @param {string} cacheDir Directory of previously built rails.
 * @returns {void}
 * @throws {Error} When a retained rail is neither built nor cached.
 */
function assembleRails(rails, tag, cacheDir) {
    for (const rail of rails) {
        const target = path.join(distDir, "r", rail);
        if (rail === tag) {
            run("npm", ["run", "build:rail", "--", "--env", `rail=${rail}`]);
            fs.rmSync(path.join(cacheDir, rail), {
                recursive: true,
                force: true,
            });
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.cpSync(target, path.join(cacheDir, rail), { recursive: true });
        } else {
            const cached = path.join(cacheDir, rail);
            if (!fs.existsSync(cached)) {
                throw new Error(
                    `rail ${rail} is retained but not cached in ${cacheDir}.\n` +
                        `Check out ${rail} and run this script to build it, ` +
                        "or drop it from release.json.",
                );
            }
            fs.cpSync(cached, target, { recursive: true });
        }
        if (!railBundleReady(target)) {
            throw new Error(`rail ${rail} is incomplete at ${target}`);
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    syncFirebaseRc(envProjectId());

    const live = !options.channel && !options.skipDeploy;
    const tag = checkoutTag(options.tag, live);
    const rails = retainedRails();
    if (!rails.includes(tag)) {
        throw new Error(`release.json does not retain ${tag}; add it first`);
    }

    const stable = await stableRail(repoRoot);
    if (stable && !rails.includes(stable)) {
        throw new Error(
            `stable release ${stable} is not retained in release.json`,
        );
    }

    const origin = resolveOrigin(options);
    console.log(`[RELEASE] tag ${tag}`);
    console.log(`[RELEASE] stable ${stable ?? "(none published)"}`);
    console.log(`[RELEASE] origin ${origin}`);
    console.log(`[RELEASE] rails ${rails.join(", ")}`);

    buildLobby(origin, stable);
    assembleRails(rails, tag, options.cache);

    if (options.skipDeploy) {
        console.log("[RELEASE] assembled; not deploying.");
        return;
    }
    if (options.channel) {
        run(firebaseBin, [
            "hosting:channel:deploy",
            options.channel,
            "--expires",
            "30d",
        ]);
        return;
    }
    run(firebaseBin, ["deploy", "--only", "hosting"]);
}

main().catch((error) => {
    console.error(`[RELEASE] ${error.message}`);
    process.exit(1);
});
