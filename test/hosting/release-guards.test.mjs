/**
 * The guards that decide whether a release may be published at all.
 *
 * A Hosting version is the complete file set, so a wrong publish does not add
 * a mistake to the site -- it replaces the site. Two things stand in the way:
 * deployHosting.js, which refuses to assemble a release from a checkout that
 * is not one, and requireLiveHosting.js, the predeploy hook that refuses a raw
 * `firebase deploy` whose local tree would delete every rail that exists only
 * on the server.
 *
 * Each case here builds a throwaway git repository and asks the guard about
 * it, so the answers are the ones a practitioner would get from a real
 * checkout without their own checkout having to be moved to produce them.
 *
 * Run through `npm run test:hosting:guards`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, suite, test } from "node:test";

const require = createRequire(import.meta.url);

const { checkoutTag, retainedRails } = require("../../scripts/deployHosting");
const {
    channelDeployAncestor,
    projectMatch,
    releaseCheckout,
    releaseTreeGaps,
    retainedRails: retainedRailsOrNone,
    treeIsComplete,
} = require("../../scripts/requireLiveHosting");
const { envProjectId, syncFirebaseRc } = require("../../scripts/syncFirebaseRc");

/** Directories built for a case, removed when the file finishes. */
const built = [];

after(() => {
    for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Create an empty directory under the OS temp root.
 *
 * @param {string} label Prefix that names what the directory is for.
 * @returns {string} Absolute path to the new directory.
 */
function tempDir(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rails-${label}-`));
    built.push(dir);
    return dir;
}

/**
 * Write a file, creating the directories above it.
 *
 * @param {string} file Absolute path to write.
 * @param {string} [body] Contents.
 * @returns {void}
 */
function writeFile(file, body = "x") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/**
 * A git repository with one commit, built to order.
 *
 * Identity and branch name are set on the repository itself, so a case does
 * not depend on the practitioner's global git configuration.
 *
 * @param {object} [options] How the checkout should look.
 * @param {string} [options.tag] Tag to put on the commit, if any.
 * @param {boolean} [options.dirty] Leave an uncommitted change behind.
 * @param {string[]} [options.rails] Rails release.json retains; omit the key
 *     to leave the file out entirely.
 * @returns {string} Path to the repository.
 */
function checkout({ tag, dirty = false, rails } = {}) {
    const root = tempDir("checkout");
    const git = (...args) =>
        execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });

    git("init", "--initial-branch", "main");
    git("config", "user.email", "trial@example.com");
    git("config", "user.name", "Rail Trial");
    if (rails !== undefined) {
        writeFile(
            path.join(root, "release.json"),
            `${JSON.stringify({ rails }, null, 2)}\n`,
        );
    }
    writeFile(path.join(root, "README.md"), "a checkout\n");
    git("add", "-A");
    git("commit", "-m", "the release");
    if (tag) git("tag", tag);
    if (dirty) writeFile(path.join(root, "README.md"), "edited\n");
    return root;
}

/**
 * A process tree for the ancestor walk, described rather than spawned.
 *
 * @param {string[][]} chain argv of each process, starting with this hook's
 *     parent and walking upwards.
 * @returns {{startPid: number, readArgv: Function, readPpid: Function}}
 *     Arguments for channelDeployAncestor.
 */
function processTree(chain) {
    const firstPid = 100;
    return {
        startPid: firstPid,
        readArgv: (pid) => chain[pid - firstPid] ?? [],
        // The last process in the chain is a child of init, which ends the walk.
        readPpid: (pid) => (pid - firstPid + 1 < chain.length ? pid + 1 : 1),
    };
}

/**
 * Ask whether a described process tree looks like a channel deploy.
 *
 * @param {string[][]} chain argv of each ancestor, nearest first.
 * @returns {boolean} What the guard answered.
 */
function ancestorSays(chain) {
    const tree = processTree(chain);
    return channelDeployAncestor(tree.startPid, tree.readArgv, tree.readPpid);
}

/** The Firebase CLI as npm installs it into the repository. */
const FIREBASE_BIN = ["node_modules/.bin/firebase"];

suite("only a clean checkout at a release tag qualifies as a release", () => {
    test("returns the release tag on a clean working tree", () => {
        const root = checkout({ tag: "v1.2.3" });
        assert.deepEqual(checkoutTag(root), {
            tag: "v1.2.3",
            builtFrom: null,
        });
        assert.equal(releaseCheckout(root), "v1.2.3");
    });

    test("disqualifies a release tag when the working tree has uncommitted changes", () => {
        // The tag would name bytes that are not the ones being built.
        const root = checkout({ tag: "v1.2.3", dirty: true });
        const { tag, builtFrom } = checkoutTag(root);
        assert.equal(tag, null);
        assert.match(builtFrom, /^v1\.2\.3-dirty$/);
        assert.equal(releaseCheckout(root), null);
    });

    test("disqualifies a release tag when HEAD is past the tagged commit", () => {
        const root = checkout({ tag: "v1.2.3" });
        execFileSync("git", ["commit", "--allow-empty", "-m", "after"], {
            cwd: root,
            stdio: "ignore",
        });
        const { tag, builtFrom } = checkoutTag(root);
        assert.equal(tag, null);
        assert.match(builtFrom, /^v1\.2\.3-1-g[0-9a-f]+$/);
        assert.equal(releaseCheckout(root), null);
    });

    test("rejects tags that do not match the release grammar", () => {
        for (const name of ["v1.2", "release-1", "latest"]) {
            const root = checkout({ tag: name });
            const { tag, builtFrom } = checkoutTag(root);
            assert.equal(tag, null, `${name} should not name a rail`);
            assert.ok(builtFrom, "the checkout should still describe itself");
            assert.equal(releaseCheckout(root), null);
        }
    });

    test("describes an untagged checkout by its commit hash with tag null", () => {
        const root = checkout();
        const { tag, builtFrom } = checkoutTag(root);
        assert.equal(tag, null);
        assert.match(builtFrom, /^[0-9a-f]{7,}$/);
        assert.equal(releaseCheckout(root), null);
    });

    test("returns a descriptive fallback instead of throwing when git cannot inspect the directory", () => {
        const root = tempDir("not-a-repo");
        const { tag, builtFrom } = checkoutTag(root);
        assert.equal(tag, null);
        assert.equal(builtFrom, "(git cannot answer)");
        assert.equal(releaseCheckout(root), null);
    });
});

suite("a release requires a non-empty list of valid rail tags in release.json", () => {
    test("returns the release tags listed in release.json", () => {
        const root = checkout({ rails: ["v0.1.0", "v0.2.0-alpha1"] });
        assert.deepEqual(retainedRails(root), ["v0.1.0", "v0.2.0-alpha1"]);
    });

    test("throws when release.json lists an empty rails array", () => {
        const root = checkout({ rails: [] });
        assert.throws(() => retainedRails(root), /lists no rails/);
    });

    test("throws and names every entry that does not match the release tag grammar", () => {
        const root = checkout({ rails: ["v0.1.0", "main", "v1.2"] });
        assert.throws(() => retainedRails(root), /not release tags: main, v1\.2/);
    });

    test("throws when release.json is missing", () => {
        assert.throws(() => retainedRails(checkout()), /release\.json/);
    });

    test("predeploy retainedRails returns an empty array instead of throwing on missing or malformed release.json", () => {
        assert.deepEqual(
            retainedRailsOrNone(checkout({ rails: ["v0.1.0"] })),
            ["v0.1.0"],
        );
        assert.deepEqual(retainedRailsOrNone(checkout()), []);
        const malformed = checkout({ rails: ["v0.1.0"] });
        fs.writeFileSync(path.join(malformed, "release.json"), "{not json");
        assert.deepEqual(retainedRailsOrNone(malformed), []);
    });
});

suite("an upload tree is complete only when the lobby, fallback operator, and all retained rails are present", () => {
    /**
     * An assembled tree, with the pieces a case says it has.
     *
     * @param {object} parts Which pieces to write.
     * @param {boolean} [parts.lobby] Emit the root index.html.
     * @param {boolean} [parts.fallback] Emit /operator/index.html.
     * @param {string[]} [parts.rails] Rails to emit completely.
     * @returns {string} Path to the tree.
     */
    const tree = ({ lobby = true, fallback = true, rails = [] }) => {
        const dir = tempDir("tree");
        if (lobby) writeFile(path.join(dir, "index.html"));
        if (fallback) writeFile(path.join(dir, "operator", "index.html"));
        for (const rail of rails) {
            writeFile(path.join(dir, "r", rail, "operator", "index.html"));
            writeFile(path.join(dir, "r", rail, "manifest.json"), "{}");
        }
        return dir;
    };

    test("reports no gaps when lobby, fallback operator page, and all retained rails are present", () => {
        const gaps = releaseTreeGaps(tree({ rails: ["v0.1.0", "v0.2.0"] }), [
            "v0.1.0",
            "v0.2.0",
        ]);
        assert.deepEqual(gaps, { lobby: false, fallback: false, rails: [] });
        assert.equal(treeIsComplete(gaps), true);
    });

    test("reports any retained rail absent from the local dist-firebase tree", () => {
        const gaps = releaseTreeGaps(tree({ rails: ["v0.2.0"] }), [
            "v0.1.0",
            "v0.2.0",
        ]);
        assert.deepEqual(gaps.rails, ["v0.1.0"]);
        assert.equal(treeIsComplete(gaps), false);
    });

    test("reports a rail directory that is missing its manifest.json", () => {
        const dir = tree({ rails: [] });
        writeFile(path.join(dir, "r", "v0.1.0", "operator", "index.html"));
        const gaps = releaseTreeGaps(dir, ["v0.1.0"]);
        assert.deepEqual(gaps.rails, ["v0.1.0"], "a rail with no manifest is not a rail");
        assert.equal(treeIsComplete(gaps), false);
    });

    test("reports a missing root lobby index.html", () => {
        const gaps = releaseTreeGaps(tree({ lobby: false }), []);
        assert.equal(gaps.lobby, true);
        assert.equal(treeIsComplete(gaps), false);
    });

    test("reports a missing fallback /operator/index.html", () => {
        const gaps = releaseTreeGaps(tree({ fallback: false }), []);
        assert.equal(gaps.fallback, true);
        assert.equal(treeIsComplete(gaps), false);
    });

    test("reports all components missing on an empty directory", () => {
        const gaps = releaseTreeGaps(tempDir("empty"), ["v0.1.0"]);
        assert.deepEqual(gaps, {
            lobby: true,
            fallback: true,
            rails: ["v0.1.0"],
        });
        assert.equal(treeIsComplete(gaps), false);
    });
});

suite("the predeploy hook allows only firebase hosting:channel:deploy", () => {
    test("returns true when an ancestor is the Firebase CLI running hosting:channel:deploy", () => {
        assert.equal(
            ancestorSays([
                ["node", "scripts/requireLiveHosting.js"],
                [...FIREBASE_BIN, "hosting:channel:deploy", "branch-main"],
            ]),
            true,
        );
    });

    test("returns true when the Firebase CLI is invoked via node firebase.js", () => {
        assert.equal(
            ancestorSays([
                [
                    "/usr/bin/node",
                    "/usr/lib/node_modules/firebase-tools/lib/bin/firebase.js",
                    "hosting:channel:deploy",
                    "branch-main",
                ],
            ]),
            true,
        );
    });

    test("returns false for a live firebase deploy", () => {
        assert.equal(
            ancestorSays([[...FIREBASE_BIN, "deploy", "--only", "hosting"]]),
            false,
        );
    });

    test("returns false when a shell command string mentions hosting:channel:deploy without running the CLI", () => {
        // Substring matching on a shell command line would match arguments
        // that never invoked the Firebase CLI binary.
        assert.equal(
            ancestorSays([
                ["sh", "-c", "firebase hosting:channel:deploy branch-main"],
            ]),
            false,
        );
    });

    test("returns false when a non-Firebase script receives hosting:channel:deploy as an argument", () => {
        assert.equal(
            ancestorSays([["node", "deploy.js", "hosting:channel:deploy"]]),
            false,
        );
    });

    test("returns false when the Firebase CLI runs a different subcommand", () => {
        assert.equal(
            ancestorSays([[...FIREBASE_BIN, "database:get", "/.settings/rules"]]),
            false,
        );
    });

    test("continues walking past ancestors whose /proc cmdline cannot be read", () => {
        assert.equal(
            ancestorSays([
                [],
                [],
                [...FIREBASE_BIN, "hosting:channel:deploy", "branch-main"],
            ]),
            true,
        );
    });

    test("stops walking after ANCESTOR_DEPTH (8) hops", () => {
        const deep = Array.from({ length: 9 }, () => ["npm", "exec"]);
        deep.push([...FIREBASE_BIN, "hosting:channel:deploy"]);
        assert.equal(ancestorSays(deep), false);
    });

    test("returns false when the ancestor list is empty", () => {
        assert.equal(ancestorSays([]), false);
    });
});

suite(".firebaserc must match the Firebase project in .env", () => {
    let savedProjectEnv;

    before(() => {
        savedProjectEnv = process.env.PUBLIC_FIREBASE_PROJECT_ID;
    });

    afterEach(() => {
        if (savedProjectEnv === undefined) {
            delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        } else {
            process.env.PUBLIC_FIREBASE_PROJECT_ID = savedProjectEnv;
        }
    });

    test("syncFirebaseRc writes projects.default while preserving other keys and aliases", () => {
        const dir = tempDir("rc");
        const rcFile = path.join(dir, ".firebaserc");
        writeFile(
            rcFile,
            JSON.stringify({
                projects: { default: "old-project", staging: "staging-project" },
                targets: { "old-project": {} },
            }),
        );

        assert.equal(syncFirebaseRc("new-project", rcFile), "written");
        const updated = JSON.parse(fs.readFileSync(rcFile, "utf8"));
        assert.equal(updated.projects.default, "new-project");
        assert.equal(updated.projects.staging, "staging-project");
        assert.deepEqual(updated.targets, { "old-project": {} });

        assert.equal(syncFirebaseRc("new-project", rcFile), "unchanged");
        assert.equal(syncFirebaseRc("", rcFile), "skipped");
    });

    test("envProjectId reads PUBLIC_FIREBASE_PROJECT_ID from .env or falls back to process.env", () => {
        delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        const dir = tempDir("envproj");
        assert.equal(envProjectId(dir), "");

        process.env.PUBLIC_FIREBASE_PROJECT_ID = "from-process-env";
        assert.equal(envProjectId(dir), "from-process-env");

        writeFile(path.join(dir, ".env"), "PUBLIC_FIREBASE_PROJECT_ID=from-dotenv\n");
        assert.equal(envProjectId(dir), "from-dotenv");
    });

    test("projectMatch rejects when .firebaserc disagrees with .env and succeeds once synced", () => {
        delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        const dir = tempDir("match");
        writeFile(path.join(dir, ".env"), "PUBLIC_FIREBASE_PROJECT_ID=project-a\n");
        writeFile(
            path.join(dir, ".firebaserc"),
            JSON.stringify({ projects: { default: "project-b" } }),
        );

        assert.deepEqual(projectMatch(dir), {
            matches: false,
            fromEnv: "project-a",
            fromRc: "project-b",
        });

        // Positive control: syncing .firebaserc to the .env project resolves the mismatch.
        syncFirebaseRc("project-a", path.join(dir, ".firebaserc"));
        assert.deepEqual(projectMatch(dir), {
            matches: true,
            fromEnv: "project-a",
            fromRc: "project-a",
        });
    });

    test("projectMatch succeeds when no project is configured in .env", () => {
        delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        const dir = tempDir("noenv");
        assert.deepEqual(projectMatch(dir), {
            matches: true,
            fromEnv: "",
            fromRc: undefined,
        });
    });
});
