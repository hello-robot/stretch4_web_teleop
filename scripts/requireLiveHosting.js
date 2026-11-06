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

/**
 * Verify that `.firebaserc` matches the project configured in `.env`.
 *
 * The CLI resolves its project from `.firebaserc` before this hook runs, so a
 * stale file cannot be corrected here -- only caught. Aborting in predeploy
 * stops the upload so one project's interface is never published over another
 * project's data.
 *
 * @returns {void}
 */
function requireMatchingProject() {
    const fromEnv = envProjectId();
    if (!fromEnv) return;
    let fromRc;
    try {
        fromRc = JSON.parse(
            fs.readFileSync(path.join(repoRoot, ".firebaserc"), "utf8"),
        ).projects?.default;
    } catch {
        fromRc = undefined;
    }
    if (fromRc !== fromEnv) {
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
 * @returns {boolean} True when an ancestor is `firebase hosting:channel:deploy`.
 */
function channelDeployAncestor() {
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 1; i += 1) {
        const args = argv(pid);
        const isCli = args.some((arg) =>
            /^firebase(\.js)?$/.test(path.basename(arg)),
        );
        if (isCli && args.includes("hosting:channel:deploy")) return true;
        pid = ppid(pid);
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

const missingRails = rails.filter(
    (rail) => !railBundleReady(path.join(distDir, "r", rail)),
);
if (
    !lobbyBundleReady(distDir) ||
    !fs.existsSync(path.join(distDir, "operator", "index.html")) ||
    missingRails.length > 0
) {
    console.error(
        "Refusing raw firebase deploy: dist-firebase/ does not contain a complete release tree\n" +
            (missingRails.length > 0
                ? `(missing local rail bundles: ${missingRails.join(", ")}).\n`
                : "(missing root index.html or /operator/index.html).\n") +
            "Use `npm run deploy:hosting` so retained rails are cloned server-side.",
    );
    process.exit(1);
}
