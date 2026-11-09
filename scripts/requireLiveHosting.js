#!/usr/bin/env node

/**
 * Hosting predeploy gate for the live site.
 *
 * `firebase deploy` (including `--only hosting`) replaces the live channel
 * with the contents of `dist-firebase/`. That is only safe when:
 *   1. The working tree is a clean checkout of a release tag retained in
 *      `release.json`, and
 *   2. `dist-firebase/` contains the lobby, `/operator/`, and every rail
 *      listed in `release.json` (otherwise a raw CLI deploy would delete any
 *      rail that was only present on the server).
 *
 * Normal live and preview releases go through `npm run deploy:hosting`
 * (`scripts/deployHosting.js`), which clones retained rails server-side.
 *
 * `hosting:channel:deploy` (used by `firebase_hosting_autodeploy.js` for
 * `branch-<slug>` channels) runs this same hook; the CLI already rejects a
 * channel id of "live", so channel deploys are allowed once project matching
 * passes.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { isReleaseTag } = require("./releaseTag");
const {
    lobbyBundleReady,
    railBundleReady,
} = require("./hostingBundleReady");
const { envProjectId } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");

/** How far up the process tree the Firebase CLI is looked for. */
const ANCESTOR_DEPTH = 8;

/**
 * Check whether `.firebaserc` matches the project configured in `.env`.
 *
 * The CLI resolves its project from `.firebaserc` before this hook runs, so a
 * stale file cannot be corrected here -- only caught.
 *
 * @param {string} [root] Repository root containing `.env` and `.firebaserc`.
 * @returns {{matches: boolean, fromEnv: string, fromRc: string|undefined}}
 *     Whether the projects match and the values read from each file.
 */
function projectMatch(root = repoRoot) {
    const fromEnv = envProjectId(root);
    if (!fromEnv) {
        return { matches: true, fromEnv: "", fromRc: undefined };
    }
    let fromRc;
    try {
        fromRc = JSON.parse(
            fs.readFileSync(path.join(root, ".firebaserc"), "utf8"),
        ).projects?.default;
    } catch {
        // Missing or unreadable .firebaserc means no default project is configured.
        fromRc = undefined;
    }
    return { matches: fromRc === fromEnv, fromEnv, fromRc };
}

/**
 * Abort the predeploy hook when `.firebaserc` disagrees with `.env`.
 *
 * @param {string} [root] Repository root containing `.env` and `.firebaserc`.
 * @returns {void}
 */
function requireMatchingProject(root = repoRoot) {
    const { matches, fromEnv, fromRc } = projectMatch(root);
    if (!matches) {
        console.error(
            `.firebaserc targets ${fromRc ?? "no project"} but .env projectId is ${fromEnv}.\n` +
                "Run: node scripts/syncFirebaseRc.js",
        );
        process.exit(1);
    }
}

/**
 * Arguments of a process, kept separate.
 *
 * @param {number} pid Process to read.
 * @returns {string[]} argv entries, or an empty list when it cannot be read.
 */
function argv(pid) {
    try {
        return fs
            .readFileSync(`/proc/${pid}/cmdline`, "utf8")
            .split("\0")
            .filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Parent process id of a process.
 *
 * @param {number} pid Process to inspect.
 * @returns {number} Parent pid, or 0 when unavailable.
 */
function ppid(pid) {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const match = status.match(/^PPid:\s+(\d+)/m);
        return match ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}

/**
 * Whether the Firebase CLI is running a channel deploy above this hook.
 *
 * Matched on argv entries rather than on the command line as text. A
 * substring search opens the gate for any ancestor that merely mentions the
 * subcommand -- a shell invoked with it in -c, a wrapper carrying it as an
 * argument -- which is a bypass of the live-site gate by accident.
 *
 * The readers are parameters so the walk can be exercised over a process tree
 * that is described rather than spawned; nothing but a test passes them.
 *
 * @param {number} [startPid] First process to inspect, this hook's parent.
 * @param {(pid: number) => string[]} [readArgv] Reads a process's argv.
 * @param {(pid: number) => number} [readPpid] Reads a process's parent pid.
 * @returns {boolean} True when an ancestor is `firebase hosting:channel:deploy`.
 */
function channelDeployAncestor(
    startPid = process.ppid,
    readArgv = argv,
    readPpid = ppid,
) {
    let pid = startPid;
    for (let i = 0; i < ANCESTOR_DEPTH && pid > 1; i += 1) {
        const args = readArgv(pid);
        const isCli = args.some((arg) =>
            /^firebase(\.js)?$/.test(path.basename(arg)),
        );
        if (isCli && args.includes("hosting:channel:deploy")) return true;
        pid = readPpid(pid);
    }
    return false;
}

/**
 * Whether this checkout is a clean tree sitting exactly on a release tag.
 *
 * @param {string} root Directory to inspect.
 * @returns {string|null} The tag, or null when this is not a release checkout.
 */
function releaseCheckout(root) {
    const git = (args) => {
        try {
            return execFileSync("git", args, {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            return null;
        }
    };
    if (git(["status", "--porcelain"]) !== "") return null;
    const tag = git(["describe", "--tags", "--exact-match", "--match", "v*"]);
    return isReleaseTag(tag) ? tag : null;
}

/**
 * Read the retained rail tags from `release.json`.
 *
 * @param {string} root Repository root.
 * @returns {string[]} Retained release tags.
 */
function retainedRails(root) {
    try {
        const parsed = JSON.parse(
            fs.readFileSync(path.join(root, "release.json"), "utf8"),
        );
        return Array.isArray(parsed.rails) ? parsed.rails : [];
    } catch {
        return [];
    }
}

/**
 * What an assembled tree is missing before it may be published as a whole site.
 *
 * `firebase deploy` uploads this directory as the complete file set, so
 * anything absent from it is deleted from the site rather than left alone.
 *
 * @param {string} dist Directory the CLI would upload.
 * @param {string[]} rails Release tags release.json retains.
 * @returns {{lobby: boolean, fallback: boolean, rails: string[]}} Whether the
 *     root page and the unversioned operator page are missing, and which
 *     retained rails have no complete bundle in the tree.
 */
function releaseTreeGaps(dist, rails) {
    return {
        lobby: !lobbyBundleReady(dist),
        fallback: !fs.existsSync(path.join(dist, "operator", "index.html")),
        rails: rails.filter(
            (rail) => !railBundleReady(path.join(dist, "r", rail)),
        ),
    };
}

/**
 * Whether a tree may be published as the whole site.
 *
 * @param {{lobby: boolean, fallback: boolean, rails: string[]}} gaps What
 *     releaseTreeGaps found.
 * @returns {boolean} True when nothing is missing.
 */
function treeIsComplete(gaps) {
    return !gaps.lobby && !gaps.fallback && gaps.rails.length === 0;
}

/**
 * Decide whether to let this `firebase deploy` proceed.
 *
 * @returns {void}
 */
function main() {
    requireMatchingProject();

    if (channelDeployAncestor()) {
        process.exit(0);
    }

    const tag = releaseCheckout(repoRoot);
    const rails = retainedRails(repoRoot);

    if (!tag || !rails.includes(tag)) {
        console.error(
            "Refusing to publish the live site via firebase deploy.\n" +
                "Live releases must come from a clean checkout of a tag retained in release.json.\n" +
                "Use: npm run deploy:hosting (or npm run deploy:hosting -- --preview for a preview channel).",
        );
        process.exit(1);
    }

    const gaps = releaseTreeGaps(distDir, rails);
    if (!treeIsComplete(gaps)) {
        console.error(
            "Refusing raw firebase deploy: dist-firebase/ does not contain a complete release tree\n" +
                (gaps.rails.length > 0
                    ? `(missing local rail bundles: ${gaps.rails.join(", ")}).\n`
                    : "(missing root index.html or /operator/index.html).\n") +
                "Use `npm run deploy:hosting` so retained rails are cloned server-side.",
        );
        process.exit(1);
    }
}

module.exports = {
    channelDeployAncestor,
    projectMatch,
    releaseCheckout,
    releaseTreeGaps,
    retainedRails,
    treeIsComplete,
};

// Guarded so the helpers above can be required without gating anything.
if (require.main === module) {
    main();
}
