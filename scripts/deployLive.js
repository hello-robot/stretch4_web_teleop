#!/usr/bin/env node

"use strict";

/**
 * Publish the live site.
 *
 *     npm run deploy:firebase
 *     npm run deploy:firebase --allow-dirty
 *
 * The live channel is what every operator loads to drive a robot, so the
 * default path publishes only a clean `main` whose HEAD is already on origin:
 * whatever is live can always be checked out by someone else.
 *
 * --allow-dirty lifts that for a hotfix that cannot wait for review, or for
 * behaviour that only reproduces on the canonical domain. It names each state
 * that makes the build unreproducible and asks for confirmation. A deploy that
 * takes it puts code on the fleet's URL that exists only on one machine, so
 * whoever debugs it next has nothing to check out: push and redeploy as soon
 * as the change is working.
 *
 * The override travels to the Hosting predeploy hook through the environment,
 * since `firebase deploy` spawns that hook itself. Keep it on the child
 * process: a shell that exports WEB_TELEOP_ALLOW_DIRTY_LIVE has opened the
 * live channel to every deploy it runs, silently.
 */

const path = require("path");
const readline = require("readline");
const { execFileSync, spawnSync } = require("child_process");
const { hostingChannel } = require("./hostingChannel");
const { envProjectId, syncFirebaseRc } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");

/**
 * Whether --allow-dirty was asked for, in either spelling npm supports.
 *
 * npm claims a flag in `npm run deploy:firebase --allow-dirty` as its own
 * config and exports it as npm_config_allow_dirty; after a `--` it arrives in
 * argv instead. People type both, so both count.
 *
 * Reading npm's config form means `allow-dirty=true` in any .npmrc on this
 * machine also opens the live channel, with nothing on screen to say so.
 *
 * @returns {boolean}
 */
function allowDirtyRequested() {
    if (process.argv.includes("--allow-dirty")) return true;
    const fromNpm = process.env.npm_config_allow_dirty;
    return Boolean(fromNpm) && fromNpm !== "false";
}
const ALLOW_ENV = "WEB_TELEOP_ALLOW_DIRTY_LIVE";
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

/**
 * @param {string[]} args
 * @returns {string} trimmed stdout, or "" when git fails
 */
function git(args) {
    try {
        return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "";
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} [env] extra environment for the child
 */
function run(command, args, env) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, ...env },
    });
    if (result.status !== 0)
        process.exit(result.status === null ? 1 : result.status);
}

/**
 * The state a dirty deploy destroys the record of: which branch, which commit,
 * what was uncommitted, and how far it had drifted from the remote.
 *
 * @returns {{ branch: string, head: string, dirty: string[], ahead: number, behind: number, upstream: string | null }}
 */
function describeCheckout() {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const head = git(["rev-parse", "--short", "HEAD"]);
    const status = git(["status", "--porcelain"]);
    const dirty = status ? status.split("\n").filter(Boolean) : [];

    let upstream = null;
    let ahead = 0;
    let behind = 0;
    if (branch && branch !== "HEAD") {
        const candidate = `origin/${branch}`;
        if (git(["rev-parse", "--verify", "--quiet", candidate])) {
            upstream = candidate;
            ahead = Number(
                git(["rev-list", "--count", `${candidate}..HEAD`]) || 0
            );
            behind = Number(
                git(["rev-list", "--count", `HEAD..${candidate}`]) || 0
            );
        }
    }
    return { branch, head, dirty, ahead, behind, upstream };
}

/**
 * @param {string} question
 * @returns {Promise<boolean>} true when the answer is exactly "yes"
 */
function confirmYes(question) {
    // A non-interactive run has already opted in by passing the flag; there is
    // nobody to ask, and blocking would strand a release script.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`${question} (no terminal; proceeding)`);
        return Promise.resolve(true);
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.on("SIGINT", () => {
            rl.close();
            console.log("\nNothing was deployed.");
            process.exit(130);
        });
        rl.question(`${question} `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "yes");
        });
    });
}

/**
 * @param {object} state from describeCheckout
 * @param {string} projectId
 */
function warnUnreleasable(state, projectId) {
    const where =
        state.branch === "HEAD"
            ? `detached at ${state.head}`
            : `${state.branch} at ${state.head}`;
    console.log("");
    console.log(
        `About to publish the LIVE site for ${projectId} from ${where}.`
    );
    console.log("");

    if (state.branch !== "main" && state.branch !== "HEAD") {
        console.log(
            `  - Not main. Operators on the main URL will run ${state.branch}.`
        );
    }
    if (state.branch === "HEAD") {
        console.log("  - Detached HEAD. No branch names what goes live.");
    }
    if (state.dirty.length > 0) {
        console.log(
            `  - ${state.dirty.length} uncommitted change(s), which WILL be published:`
        );
        state.dirty
            .slice(0, 10)
            .forEach((line) => console.log(`      ${line}`));
        if (state.dirty.length > 10) {
            console.log(`      ...and ${state.dirty.length - 10} more`);
        }
    }
    if (state.ahead > 0) {
        console.log(
            `  - ${state.ahead} commit(s) not pushed to ${state.upstream}.`
        );
    }
    if (state.behind > 0) {
        console.log(
            `  - ${state.behind} commit(s) behind ${state.upstream}; their work will be overwritten on the live site.`
        );
    }
    if (!state.upstream && state.branch !== "HEAD") {
        console.log(
            `  - origin/${state.branch} does not exist. Nothing about this build is on the remote.`
        );
    }

    console.log("");
    console.log(
        "  This also deploys database.rules.json to the shared database."
    );
    if (state.dirty.length > 0 || state.ahead > 0 || !state.upstream) {
        console.log(
            "  No commit on origin matches what goes live, so nobody can check it out"
        );
        console.log(
            "  to reproduce a problem. Push and redeploy once it is working."
        );
    }
    console.log("");
}

async function main() {
    const allowDirty = allowDirtyRequested();

    syncFirebaseRc(envProjectId());
    const projectId = envProjectId() || "this project";

    // origin/main is what the gate compares against, so make it current first.
    run("git", ["fetch", "origin", "main"]);
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (allowDirty && current && current !== "HEAD" && current !== "main") {
        // Best effort: a branch that is not on origin simply has no upstream.
        spawnSync("git", ["fetch", "origin", current], {
            cwd: repoRoot,
            stdio: "ignore",
        });
    }

    let channel = null;
    try {
        channel = hostingChannel(repoRoot);
    } catch {
        channel = null; // detached HEAD
    }

    if (!channel || !channel.live) {
        const what = channel ? channel.id : "a detached HEAD";
        if (!allowDirty) {
            console.error(
                `Refusing to publish the live site. This checkout is ${what}, not clean origin/main.`
            );
            console.error(
                "Commit and push, or publish a preview instead: npm run deploy:firebase-preview-channel"
            );
            console.error(
                "To publish it anyway, knowing it will not match any commit: npm run deploy:firebase --allow-dirty"
            );
            process.exit(1);
        }
        warnUnreleasable(describeCheckout(), projectId);
        if (!(await confirmYes('Type "yes" to publish it to the live URL:'))) {
            console.log("Nothing was deployed.");
            process.exit(1);
        }
    }

    const childEnv = allowDirty ? { [ALLOW_ENV]: "1" } : undefined;
    run("npm", ["run", "build:firebase"], childEnv);
    run(firebaseBin, ["deploy", "--only", "database,hosting"], childEnv);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
