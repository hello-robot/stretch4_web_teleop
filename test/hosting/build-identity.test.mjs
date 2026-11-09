/**
 * What a build says it is, at both ends of the rail system.
 *
 * A rail publishes manifest.json beside its operator page; a robot publishes a
 * describe to robots/<fleetId>/build. Those two are the only record of which
 * commit anything is running, and both are read back by something that acts on
 * them -- the release refuses to republish a rail whose manifest names another
 * commit, and the lobby routes a card by the rail a robot reported.
 *
 * hosting-routes.test.mjs checks that a manifest is served and cached
 * correctly, but it serves a fixture it wrote itself. This file checks the
 * manifest the build actually emits, so the two ends are not tested against
 * different data.
 *
 * Run through `npm run test:hosting:identity`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, suite, test } from "node:test";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
);

const webpack = require("webpack");
const { checkPublishedRail } = require("../../scripts/deployHosting");
const { buildFromDescribe } = require("../../scripts/releaseTag");
const { RailManifestPlugin, railManifest } = require("../../scripts/railManifest");

/** Directories built for a case, removed when the file finishes. */
const built = [];

after(() => {
    for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A git repository holding one tagged commit.
 *
 * @param {object} [options] How the checkout should look.
 * @param {string} [options.tag] Tag to put on the commit.
 * @param {boolean} [options.dirty] Leave an uncommitted change behind.
 * @returns {{root: string, head: string}} The repository and its HEAD commit.
 */
function checkout({ tag = "v1.2.3", dirty = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rails-identity-"));
    built.push(root);
    const git = (...args) =>
        execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();

    git("init", "--initial-branch", "main");
    git("config", "user.email", "trial@example.com");
    git("config", "user.name", "Rail Trial");
    fs.writeFileSync(path.join(root, "README.md"), "a release\n");
    git("add", "-A");
    git("commit", "-m", "the release");
    if (tag) git("tag", tag);
    if (dirty) fs.writeFileSync(path.join(root, "README.md"), "edited\n");
    return { root, head: git("rev-parse", "HEAD") };
}

/**
 * Run the plugin against a compiler that records what it emits.
 *
 * The hooks are stubbed but the sources and the stage constant are webpack's
 * own, so a plugin that emits the wrong kind of asset, or at a stage that does
 * not exist, fails here rather than in a release.
 *
 * @param {object} options Plugin options: the rail tag and the checkout.
 * @returns {{assets: Record<string, string>, stages: number[]}} Emitted asset
 *     text by name, and the processAssets stages the plugin asked for.
 */
function emitted(options) {
    const assets = {};
    const stages = [];
    const compilation = {
        hooks: {
            processAssets: {
                /**
                 * @param {{name: string, stage: number}} tapOptions Tap options.
                 * @param {Function} fn The plugin's callback.
                 * @returns {void}
                 */
                tap(tapOptions, fn) {
                    stages.push(tapOptions.stage);
                    fn();
                },
            },
        },
        /**
         * @param {string} name Asset filename.
         * @param {object} source Webpack source object.
         * @returns {void}
         */
        emitAsset(name, source) {
            assets[name] = source.source();
        },
    };
    const compiler = {
        webpack,
        hooks: {
            thisCompilation: {
                /**
                 * @param {string} name Plugin name.
                 * @param {Function} fn The plugin's callback.
                 * @returns {void}
                 */
                tap(name, fn) {
                    fn(compilation);
                },
            },
        },
    };

    new RailManifestPlugin(options).apply(compiler);
    return { assets, stages };
}

suite("a rail manifest records the tag, commit, and build time", () => {
    test("records the tag, HEAD commit, git describe, and ISO build timestamp", () => {
        const { root, head } = checkout({ tag: "v1.2.3" });
        const manifest = railManifest({ tag: "v1.2.3", repoRoot: root });

        assert.equal(manifest.tag, "v1.2.3");
        assert.equal(manifest.commit, head);
        assert.equal(manifest.describe, "v1.2.3");
        assert.equal(
            new Date(manifest.built).toISOString(),
            manifest.built,
            "built is not an ISO timestamp",
        );
    });

    test("emits a manifest that checkPublishedRail accepts for the same checkout and rejects for another", async () => {
        const realFetch = globalThis.fetch;
        const realLog = console.log;
        try {
            console.log = () => {};
            const other = railManifest({
                tag: "v1.2.3",
                repoRoot: checkout({ tag: "v1.2.3" }).root,
            });
            globalThis.fetch = async () => ({
                ok: true,
                status: 200,
                json: async () => other,
            });
            await assert.rejects(
                () => checkPublishedRail("https://site.web.app", "v1.2.3", null, false),
                new RegExp(`is published from ${other.commit}`),
            );

            // Positive control: a manifest generated from repoRoot has the exact
            // commit checkPublishedRail expects.
            const matching = railManifest({ tag: "v1.2.3", repoRoot });
            globalThis.fetch = async () => ({
                ok: true,
                status: 200,
                json: async () => matching,
            });
            await assert.doesNotReject(() =>
                checkPublishedRail("https://site.web.app", "v1.2.3", null, false),
            );
        } finally {
            globalThis.fetch = realFetch;
            console.log = realLog;
        }
    });

    test("records a dirty describe suffix when the working tree has uncommitted changes", () => {
        const { root } = checkout({ tag: "v1.2.3", dirty: true });
        const manifest = railManifest({ tag: "v1.2.3", repoRoot: root });
        assert.equal(manifest.tag, "v1.2.3");
        assert.equal(manifest.describe, "v1.2.3-dirty");
    });

    test("sets commit and describe to null when git cannot read the directory", () => {
        // Null commit causes checkPublishedRail to refuse a live republish
        // rather than treating an unreadable git directory as a match.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rails-nogit-"));
        built.push(dir);
        const manifest = railManifest({ tag: "v1.2.3", repoRoot: dir });
        assert.equal(manifest.commit, null);
        assert.equal(manifest.describe, null);
        assert.equal(manifest.tag, "v1.2.3");
    });
});

suite("RailManifestPlugin emits manifest.json into the compilation", () => {
    test("emits manifest.json at the rail root with the checkout's metadata", () => {
        const { root, head } = checkout({ tag: "v1.2.3" });
        const { assets } = emitted({ tag: "v1.2.3", repoRoot: root });

        assert.deepEqual(Object.keys(assets), ["manifest.json"]);
        const manifest = JSON.parse(assets["manifest.json"]);
        assert.equal(manifest.tag, "v1.2.3");
        assert.equal(manifest.commit, head);
        assert.ok(manifest.built);
    });

    test("taps processAssets at PROCESS_ASSETS_STAGE_ADDITIONAL", () => {
        const { root } = checkout();
        const { stages } = emitted({ tag: "v1.2.3", repoRoot: root });
        assert.deepEqual(stages, [
            webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        ]);
    });

    test("formats manifest.json as 2-space indented, newline-terminated JSON", () => {
        const { root } = checkout();
        const { assets } = emitted({ tag: "v1.2.3", repoRoot: root });
        assert.match(assets["manifest.json"], /^\{\n  "tag": "v1\.2\.3",\n/);
        assert.match(assets["manifest.json"], /\}\n$/);
    });
});

suite("a robot publishes a rail in its build record only when on a clean release tag", () => {
    test("sets both describe and rail when the describe is an exact release tag", () => {
        assert.deepEqual(buildFromDescribe("v1.2.3"), {
            describe: "v1.2.3",
            rail: "v1.2.3",
        });
        assert.deepEqual(buildFromDescribe("v2.0.0-rc10"), {
            describe: "v2.0.0-rc10",
            rail: "v2.0.0-rc10",
        });
    });

    test("omits rail when commits follow the release tag", () => {
        assert.deepEqual(buildFromDescribe("v1.2.3-4-gabc1234"), {
            describe: "v1.2.3-4-gabc1234",
        });
    });

    test("omits rail when the working tree is dirty", () => {
        assert.deepEqual(buildFromDescribe("v1.2.3-dirty"), {
            describe: "v1.2.3-dirty",
        });
    });

    test("omits rail when the tag does not match the release grammar", () => {
        assert.deepEqual(buildFromDescribe("v1.2"), { describe: "v1.2" });
        assert.deepEqual(buildFromDescribe("latest"), { describe: "latest" });
    });

    test("publishes a bare commit hash without a rail so the lobby detects an unreleased build", () => {
        assert.deepEqual(buildFromDescribe("abc1234"), { describe: "abc1234" });
    });

    test("trims trailing newlines from git describe output", () => {
        assert.deepEqual(buildFromDescribe("v1.2.3\n"), {
            describe: "v1.2.3",
            rail: "v1.2.3",
        });
    });

    test("returns null for empty, whitespace-only, or non-string inputs", () => {
        for (const answer of ["", "   ", "\n", null, undefined, 1, {}]) {
            assert.equal(buildFromDescribe(answer), null);
        }
    });
});
