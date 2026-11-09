/**
 * The decision logic of the multi-rail hosting backend, exercised offline.
 *
 * Every case here runs without a network, without Firebase credentials and
 * without a webpack build, so the whole file is a gate that can run anywhere.
 * What it covers is the part of a release that decides *what* is published:
 * the tag grammar, the flags, the origin and channel resolution, the stable
 * release the fleet defaults to, the bundle guards, the immutability check,
 * and the webpack wiring that puts a rail under /r/<tag>/.
 *
 * What it deliberately does not cover: the server-side clone in
 * hostingVersion.js, which cannot be decided without a Hosting site, and the
 * guards that refuse a release outright, which need a checkout to refuse.
 * Those are test/hosting/hosting-routes.test.mjs and
 * test/hosting/release-guards.test.mjs.
 *
 * Run through `npm run test:hosting:backend`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, suite, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
);

const { RELEASE_TAG, isReleaseTag } = require("../../scripts/releaseTag");
const { branchSlug } = require("../../scripts/hostingChannel");
const {
    hostingBundleReady,
    lobbyBundleReady,
    railBundleReady,
} = require("../../scripts/hostingBundleReady");
const {
    hostingVersionConfig,
    railCloneRegexes,
    servedAt,
    servedFiles,
    siteFromOrigin,
} = require("../../scripts/hostingVersion");
const {
    assembleRails,
    checkPublishedRail,
    isPreviewOrigin,
    parseArgs,
    previewChannelId,
    publishedManifest,
} = require("../../scripts/deployHosting");
const { repoSlug, stableRail } = require("../../scripts/stableRail");
const {
    PUBLIC_WEBPACK_ENV_KEYS,
    webpackPublicEnvDefinitions,
} = require("../../scripts/webpackPublicEnv");
const makeWebpackConfig = require("../../webpack.config");

/** Tags the rails may be named with. */
const VALID_TAGS = [
    "v0.1.0",
    "v1.2.3",
    "v10.20.30",
    "v2.0.0-alpha1",
    "v2.0.0-beta2",
    "v2.0.0-rc10",
];

/**
 * Tags that must be refused. Each would become a /r/<segment>/ path, so the
 * list leans on the shapes that are nearly right: a describe off a tag, a
 * pre-release word the grammar does not know, and a traversal attempt.
 */
const INVALID_TAGS = [
    "v1.2",
    "1.2.3",
    "v1.2.3.4",
    "v1.2.3-dev1",
    "v1.2.3-rc",
    "v1.2.3-4-gabc1234",
    "v1.2.3-dirty",
    "v1.2.3/../../etc",
    "../v1.2.3",
    "",
    "latest",
];

/** Environment keys npm exports when `--` is omitted before a flag. */
const NPM_CONFIG_KEYS = [
    "npm_config_dry_run",
    "npm_config_preview",
    "npm_config_rail_only",
    "npm_config_skip_deploy",
];

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
 * Stand in for one fetch of a rail manifest.
 *
 * @param {{status?: number, body?: object, throws?: boolean}} answer What the
 *     origin does: a status with an optional JSON body, or a thrown request.
 * @returns {() => Promise<object>} A fetch replacement.
 */
function stubFetch(answer) {
    return async () => {
        if (answer.throws) throw new Error("network unreachable");
        const status = answer.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => answer.body,
        };
    };
}

/**
 * A regex source rewritten into one spelling, so patterns written for
 * different engines can be compared as strings.
 *
 * The daemon and the lobby write `\d` and `\.`; the database rules, which are
 * evaluated by Firebase and not by JavaScript, write `[0-9]` and `[.]`. The
 * two are the same grammar and must stay the same grammar.
 *
 * @param {string} source Regular expression source text.
 * @returns {string} The source in the bracketed spelling.
 */
function normalizePattern(source) {
    return source.replace(/\\d/g, "[0-9]").replace(/\\\./g, "[.]");
}

suite("a rail tag is a semver release", () => {
    test("accepts a release tag and nothing that merely looks like one", () => {
        for (const tag of VALID_TAGS) {
            assert.equal(isReleaseTag(tag), true, `${tag} should be a rail`);
        }
        for (const tag of INVALID_TAGS) {
            assert.equal(isReleaseTag(tag), false, `${tag} should be refused`);
        }
    });

    test("refuses anything that is not a string", () => {
        for (const value of [null, undefined, 1, {}, ["v1.0.0"]]) {
            assert.equal(isReleaseTag(value), false);
        }
    });

    test("is the same grammar in all three places that enforce it", () => {
        // A rail name is a URL path segment, a database value and a lobby
        // route. The three copies are commented as moving together; this is
        // what makes that true rather than hoped for.
        const fromRules = JSON.parse(
            fs.readFileSync(path.join(repoRoot, "database.rules.json"), "utf8"),
        ).rules.robots.$fleetId.build.rail[".validate"];
        const rulesPattern = fromRules.match(/matches\(\/(.+)\/\)/)?.[1];
        assert.ok(rulesPattern, "database.rules.json states no rail pattern");

        const model = fs.readFileSync(
            path.join(repoRoot, "src/pages/home/tsx/robotModel.ts"),
            "utf8",
        );
        const modelPattern = model.match(/const RAIL = \/(.+)\/;/)?.[1];
        assert.ok(modelPattern, "robotModel.ts states no RAIL pattern");

        assert.equal(
            normalizePattern(modelPattern),
            normalizePattern(RELEASE_TAG.source),
            "robotModel.ts RAIL has drifted from scripts/releaseTag.js",
        );
        assert.equal(
            normalizePattern(rulesPattern),
            normalizePattern(RELEASE_TAG.source),
            "database.rules.json rail validate has drifted from scripts/releaseTag.js",
        );

        // Compared as patterns as well as as text, so a rewrite that is
        // spelled differently but behaves identically still passes.
        const rulesRegex = new RegExp(rulesPattern);
        const modelRegex = new RegExp(modelPattern);
        for (const tag of [...VALID_TAGS, ...INVALID_TAGS]) {
            assert.equal(
                rulesRegex.test(tag),
                isReleaseTag(tag),
                `database rules disagree about ${tag}`,
            );
            assert.equal(
                modelRegex.test(tag),
                isReleaseTag(tag),
                `robotModel disagrees about ${tag}`,
            );
        }
    });
});

suite("release.json retains only valid, distinct rail tags", () => {
    test("retains a non-empty set of distinct release tags", () => {
        const rails = JSON.parse(
            fs.readFileSync(path.join(repoRoot, "release.json"), "utf8"),
        ).rails;
        assert.ok(Array.isArray(rails) && rails.length > 0);
        assert.deepEqual(
            rails.filter((tag) => !isReleaseTag(tag)),
            [],
            "release.json retains something that is not a release tag",
        );
        assert.equal(
            new Set(rails).size,
            rails.length,
            "release.json retains a tag twice",
        );
    });
});

suite("the stable rail is the latest GitHub release", () => {
    /** Answers GitHub gives, so no case here reaches the network. */
    let realFetch;

    /** The URL the last stubbed request was sent to. */
    let asked;

    /** Headers the last stubbed request carried. */
    let sentHeaders;

    before(() => (realFetch = globalThis.fetch));

    after(() => {
        globalThis.fetch = realFetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        delete process.env.GITHUB_TOKEN;
    });

    /**
     * Answer the releases/latest request with one status and body.
     *
     * @param {{status?: number, body?: object, throws?: boolean}} answer What
     *     GitHub does.
     * @returns {void}
     */
    const githubAnswers = (answer) => {
        globalThis.fetch = async (url, init) => {
            asked = url;
            sentHeaders = init?.headers ?? {};
            if (answer.throws) throw new Error("network unreachable");
            const status = answer.status ?? 200;
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => answer.body,
            };
        };
    };

    /**
     * A repository whose origin points somewhere named.
     *
     * @param {string|null} url Remote URL, or null for no origin at all.
     * @returns {string} Path to the repository.
     */
    const withOrigin = (url) => {
        const root = tempDir("slug");
        const git = (...args) =>
            execFileSync("git", args, {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        git("init", "--initial-branch", "main");
        if (url) git("remote", "add", "origin", url);
        return root;
    };

    test("names the repository from any spelling of the remote", () => {
        for (const url of [
            "https://github.com/hello-robot/stretch4_web_teleop.git",
            "https://github.com/hello-robot/stretch4_web_teleop",
            "git@github.com:hello-robot/stretch4_web_teleop.git",
            "ssh://git@github.com/hello-robot/stretch4_web_teleop.git",
        ]) {
            assert.equal(
                repoSlug(withOrigin(url)),
                "hello-robot/stretch4_web_teleop",
                `${url} should name the repository`,
            );
        }
    });

    test("refuses a remote it cannot ask GitHub about", () => {
        assert.throws(
            () => repoSlug(withOrigin("https://gitlab.com/a/b.git")),
            /not a GitHub remote/,
        );
        assert.throws(() => repoSlug(withOrigin(null)));
    });

    test("a published release becomes the default rail", async () => {
        githubAnswers({ status: 200, body: { tag_name: "v0.2.0" } });
        assert.equal(await stableRail(repoRoot), "v0.2.0");
        assert.match(asked, /\/repos\/[^/]+\/[^/]+\/releases\/latest$/);
    });

    test("a repository with no release yet has no default", async () => {
        // Pushing a tag publishes nothing, so a repository can retain rails
        // long before one of them is marked latest. Robots reporting no rail
        // keep the unversioned page until then.
        githubAnswers({ status: 404 });
        assert.equal(await stableRail(repoRoot), null);
    });

    test("a release tagged outside the grammar stops the release", async () => {
        // The tag becomes PUBLIC_STABLE_RAIL and then a /r/<tag>/ path, so a
        // release named anything else is refused here rather than built.
        githubAnswers({ status: 200, body: { tag_name: "latest" } });
        await assert.rejects(() => stableRail(repoRoot), /is not a rail name/);
    });

    test("rejects on a 5xx response or network error instead of returning null", async () => {
        // Reading a fault as "no release" would quietly publish a lobby that
        // routes the whole fleet to the unversioned page.
        githubAnswers({ status: 500 });
        await assert.rejects(() => stableRail(repoRoot), /returned 500/);
        githubAnswers({ throws: true });
        await assert.rejects(() => stableRail(repoRoot), /network unreachable/);
    });

    test("a token is sent when one is set, and not invented when it is not", async () => {
        githubAnswers({ status: 200, body: { tag_name: "v0.2.0" } });
        await stableRail(repoRoot);
        assert.equal(sentHeaders.Authorization, undefined);

        process.env.GITHUB_TOKEN = "a-token";
        githubAnswers({ status: 200, body: { tag_name: "v0.2.0" } });
        await stableRail(repoRoot);
        assert.equal(sentHeaders.Authorization, "Bearer a-token");
    });
});

suite("a Hosting deploy accepts only known flags", () => {
    /** npm_config_* values this process started with, restored after each test. */
    const saved = {};

    before(() => {
        for (const key of NPM_CONFIG_KEYS) saved[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of NPM_CONFIG_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    /**
     * Clear every npm_config_* flag, so a default is read as a default.
     *
     * @returns {void}
     */
    const clearNpmConfig = () => {
        for (const key of NPM_CONFIG_KEYS) delete process.env[key];
    };

    test("defaults to a live, non-dry publish", () => {
        clearNpmConfig();
        const options = parseArgs([]);
        assert.equal(options.preview, false);
        assert.equal(options.dryRun, false);
        assert.equal(options.railOnly, false);
        assert.equal(options.republish, false);
        assert.equal(options.origin, null);
        assert.equal(options.site, null);
        assert.equal(options.cache, path.join(repoRoot, ".rails-cache"));
    });

    test("reads the boolean flags from argv", () => {
        clearNpmConfig();
        const options = parseArgs([
            "--dry-run",
            "--preview",
            "--rail-only",
            "--republish",
            "--verbose",
        ]);
        assert.equal(options.dryRun, true);
        assert.equal(options.preview, true);
        assert.equal(options.railOnly, true);
        assert.equal(options.republish, true);
        assert.equal(options.verbose, true);
    });

    test("--skip-deploy is still accepted as --dry-run", () => {
        clearNpmConfig();
        assert.equal(parseArgs(["--skip-deploy"]).dryRun, true);
    });

    test("reads the value flags from argv", () => {
        clearNpmConfig();
        const options = parseArgs([
            "--cache",
            "/tmp/rails",
            "--origin",
            "https://example.web.app",
            "--site",
            "a-site",
            "--log",
            "/tmp/release.log",
        ]);
        assert.equal(options.cache, "/tmp/rails");
        assert.equal(options.origin, "https://example.web.app");
        assert.equal(options.site, "a-site");
        assert.equal(options.log, "/tmp/release.log");
    });

    test("refuses an argument it does not know", () => {
        clearNpmConfig();
        assert.throws(() => parseArgs(["--publish-everything"]), {
            message: "unknown argument: --publish-everything",
        });
    });

    test("honours a flag npm swallowed when -- was omitted", () => {
        // `npm run deploy:hosting --dry-run` never reaches argv: npm exports
        // it instead. Reading only argv there would publish the live site.
        clearNpmConfig();
        process.env.npm_config_dry_run = "true";
        process.env.npm_config_preview = "true";
        process.env.npm_config_rail_only = "true";
        const options = parseArgs([]);
        assert.equal(options.dryRun, true);
        assert.equal(options.preview, true);
        assert.equal(options.railOnly, true);
    });

    test("npm_config_skip_deploy is read as a dry run", () => {
        clearNpmConfig();
        process.env.npm_config_skip_deploy = "true";
        assert.equal(parseArgs([]).dryRun, true);
    });

    test("an npm_config flag spelled false is not a flag", () => {
        clearNpmConfig();
        process.env.npm_config_dry_run = "false";
        assert.equal(parseArgs([]).dryRun, false);
    });
});

suite("a preview channel is named after the checkout", () => {
    /**
     * Build a throwaway repository on a branch, detached tag, or detached commit.
     *
     * @param {{branch?: string, tag?: string, detach?: boolean}} options Checkout state.
     * @returns {string} Path to the repository.
     */
    const channelRepo = ({ branch = "main", tag, detach = false } = {}) => {
        const root = tempDir("channel");
        const git = (...args) =>
            execFileSync("git", args, {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        git("init", "--initial-branch", branch);
        git("config", "user.email", "trial@example.com");
        git("config", "user.name", "Rail Trial");
        writeFile(path.join(root, "README.md"), "channel\n");
        git("add", "-A");
        git("commit", "-m", "init");
        if (tag) git("tag", tag);
        if (detach) git("checkout", "--detach", "HEAD");
        return root;
    };

    test("folds a branch name into something Hosting accepts", () => {
        assert.equal(branchSlug("feature/multi-rail"), "feature-multi-rail");
        assert.equal(branchSlug("a_b:c#d"), "a-b-c-d");
    });

    test("derives rails-<branch> from an active branch and truncates at 63 characters", () => {
        const root = channelRepo({ branch: "feature/multi-rail" });
        assert.equal(previewChannelId(root), "rails-feature-multi-rail");

        const longBranch = `feature/${"a".repeat(80)}`;
        const longRoot = channelRepo({ branch: longBranch });
        const id = previewChannelId(longRoot);
        assert.equal(id.length, 63);
        assert.ok(id.startsWith("rails-feature-a"));
        assert.ok(!id.startsWith("rails-branch-"));
    });

    test("folds dots into hyphens when detached on a release tag", () => {
        const root = channelRepo({ tag: "v1.2.3", detach: true });
        assert.equal(previewChannelId(root), "rails-v1-2-3");
    });

    test("falls back to the short commit hash when detached with no release tag", () => {
        const root = channelRepo({ detach: true });
        assert.match(previewChannelId(root), /^rails-[0-9a-f]{7,}$/);
    });
});

suite("a preview origin is distinct from the live site", () => {
    test("a resolved channel id settles it without inspecting the origin", () => {
        assert.equal(isPreviewOrigin("https://site.web.app", "rails-x"), true);
    });

    test("the doubled hyphen Hosting gives a channel settles it otherwise", () => {
        assert.equal(
            isPreviewOrigin("https://site--rails-x-a1b2c3.web.app", null),
            true,
        );
        assert.equal(isPreviewOrigin("https://site.web.app", null), false);
        assert.equal(
            isPreviewOrigin("https://teleop.example.com", null),
            false,
        );
    });

    test("an origin that cannot be parsed is not taken for a preview", () => {
        // Guessing wrong in this direction publishes a preview build to the
        // live site, so the fallback must be the strict one.
        assert.equal(isPreviewOrigin("not-a-url", null), false);
    });
});

suite("a Firebase Hosting origin encodes its site ID", () => {
    test("reads the site id from a web.app or firebaseapp.com origin", () => {
        assert.equal(siteFromOrigin("https://my-site.web.app"), "my-site");
        assert.equal(
            siteFromOrigin("https://my-site.firebaseapp.com"),
            "my-site",
        );
    });

    test("reads the site id out of a preview channel origin", () => {
        assert.equal(
            siteFromOrigin("https://my-site--rails-x-a1b2c3.web.app"),
            "my-site",
        );
    });

    test("answers null where the caller must pass --site", () => {
        assert.equal(siteFromOrigin("https://teleop.example.com"), null);
        assert.equal(siteFromOrigin("nonsense"), null);
    });
});

suite("a published version hashes and retains only its rail and root files", () => {
    let dir;

    before(() => {
        dir = tempDir("served");
        writeFile(path.join(dir, "index.html"));
        writeFile(path.join(dir, "operator", "index.html"));
        writeFile(path.join(dir, "r", "v1.0.0", "manifest.json"));
        writeFile(path.join(dir, ".hidden"));
        writeFile(path.join(dir, "node_modules", "pkg", "index.js"));
        writeFile(path.join(dir, "firebase.json"));
    });

    test("maps every deployable file to the path it is served at", () => {
        const files = servedFiles(dir);
        assert.deepEqual(Object.keys(files).sort(), [
            "/index.html",
            "/operator/index.html",
            "/r/v1.0.0/manifest.json",
        ]);
    });

    test("leaves out what firebase.json ignores", () => {
        const files = servedFiles(dir);
        assert.equal(files["/.hidden"], undefined);
        assert.equal(files["/node_modules/pkg/index.js"], undefined);
        assert.equal(files["/firebase.json"], undefined);
    });

    test("railCloneRegexes builds anchored regexes with escaped dots for retained rails", () => {
        const regexes = railCloneRegexes(["v1.2.3", "v2.0.0-rc1"]).map(
            (source) => new RegExp(source),
        );
        assert.equal(regexes[0].test("/r/v1.2.3/manifest.json"), true);
        assert.equal(regexes[0].test("/r/v1X2Y3/manifest.json"), false);
        assert.equal(regexes[0].test("/operator/index.html"), false);
        assert.equal(regexes[1].test("/r/v2.0.0-rc1/operator/index.html"), true);
    });

    test("servedAt probes with HEAD and cache: no-store, returning false on 404 or network failure", async () => {
        const realFetch = globalThis.fetch;
        try {
            const seen = [];
            globalThis.fetch = async (url, init) => {
                seen.push([url, init]);
                return { ok: true, status: 200 };
            };
            assert.equal(
                await servedAt("https://site.web.app", "/r/v1.0.0/manifest.json"),
                true,
            );
            assert.equal(seen[0][0], "https://site.web.app/r/v1.0.0/manifest.json");
            assert.equal(seen[0][1].method, "HEAD");
            assert.equal(seen[0][1].cache, "no-store");

            globalThis.fetch = stubFetch({ status: 404 });
            assert.equal(
                await servedAt("https://site.web.app", "/r/v1.0.0/manifest.json"),
                false,
            );

            globalThis.fetch = stubFetch({ throws: true });
            assert.equal(
                await servedAt("https://site.web.app", "/r/v1.0.0/manifest.json"),
                false,
            );
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

suite("a finalized version translates firebase.json into Hosting cache rules", () => {
    test("carries the cache rules firebase.json states", () => {
        // The REST API is handed this directly, so a header that is wrong
        // here is wrong on the site: rails cached for a year, and the
        // manifest that reports them carved back out to no-cache.
        const { headers } = hostingVersionConfig(repoRoot);
        const byGlob = Object.fromEntries(
            headers.map((rule) => [rule.glob, rule.headers["Cache-Control"]]),
        );
        assert.equal(byGlob["**"], "no-cache");
        assert.equal(byGlob["/r/**"], "public, max-age=31536000, immutable");
        assert.equal(byGlob["/r/*/manifest.json"], "no-cache");
        // Hosting applies the last matching rule, so the manifest carve-out
        // is only a carve-out while it sits after the /r/** rule.
        const order = headers.map((rule) => rule.glob);
        assert.ok(
            order.indexOf("/r/*/manifest.json") > order.indexOf("/r/**"),
            "the manifest rule must come after /r/** or it is overridden",
        );
    });

    test("answers an empty config where there is nothing to say", () => {
        const dir = tempDir("noconfig");
        assert.deepEqual(hostingVersionConfig(dir), {});
        fs.writeFileSync(path.join(dir, "firebase.json"), "{}");
        assert.deepEqual(hostingVersionConfig(dir), {});
    });
});

suite("a bundle is ready only when its entrypoint and manifest exist", () => {
    let dir;

    before(() => (dir = tempDir("bundles")));

    test("a lobby is ready only once it has emitted the root page", () => {
        const lobby = path.join(dir, "lobby");
        fs.mkdirSync(lobby, { recursive: true });
        assert.equal(lobbyBundleReady(lobby), false);
        writeFile(path.join(lobby, "index.html"));
        assert.equal(lobbyBundleReady(lobby), true);
    });

    test("a rail needs its operator page and its manifest", () => {
        const rail = path.join(dir, "rail");
        fs.mkdirSync(rail, { recursive: true });
        assert.equal(railBundleReady(rail), false);
        writeFile(path.join(rail, "operator", "index.html"));
        assert.equal(railBundleReady(rail), false, "manifest still missing");
        writeFile(path.join(rail, "manifest.json"), "{}");
        assert.equal(railBundleReady(rail), true);
    });

    test("a rail carrying a root page is refused", () => {
        // That page would be uploaded at /r/<tag>/index.html, which is
        // harmless, but it only appears when the rail was built with the
        // whole page set -- the same mistake that puts a second lobby in the
        // version. Refusing it here is what keeps / the lobby's alone.
        const rail = path.join(dir, "shadow");
        writeFile(path.join(rail, "operator", "index.html"));
        writeFile(path.join(rail, "manifest.json"), "{}");
        assert.equal(railBundleReady(rail), true);
        writeFile(path.join(rail, "index.html"));
        assert.equal(railBundleReady(rail), false);
    });

    test("a whole-site bundle needs all three pages", () => {
        const site = path.join(dir, "site");
        writeFile(path.join(site, "index.html"));
        writeFile(path.join(site, "operator", "index.html"));
        assert.equal(hostingBundleReady(site), false);
        writeFile(path.join(site, "robot", "index.html"));
        assert.equal(hostingBundleReady(site), true);
    });
});

suite("a release builds the current rail and copies retained rails from the cache", () => {
    /**
     * Write a complete rail bundle into a directory.
     *
     * @param {string} target Directory for the rail.
     * @returns {void}
     */
    const writeCompleteRail = (target) => {
        writeFile(path.join(target, "operator", "index.html"));
        writeFile(path.join(target, "manifest.json"), "{}\n");
    };

    test("builds and caches the current tag, copies cached rails, and lists uncached rails as missing", () => {
        const cacheDir = tempDir("cache");
        const outDir = tempDir("dist");
        writeCompleteRail(path.join(cacheDir, "v0.1.0"));

        const result = assembleRails(
            ["v0.1.0", "v0.2.0", "v0.3.0"],
            "v0.3.0",
            cacheDir,
            outDir,
            (_rail, target) => writeCompleteRail(target),
        );

        assert.deepEqual(result, {
            assembled: ["v0.1.0", "v0.3.0"],
            missing: ["v0.2.0"],
        });
        assert.equal(railBundleReady(path.join(outDir, "r", "v0.1.0")), true);
        assert.equal(railBundleReady(path.join(outDir, "r", "v0.3.0")), true);
        assert.equal(railBundleReady(path.join(cacheDir, "v0.3.0")), true);
    });

    test("throws when a cached rail is incomplete and succeeds once its manifest is present", () => {
        const cacheDir = tempDir("badcache");
        const outDir = tempDir("baddist");
        writeFile(path.join(cacheDir, "v0.1.0", "operator", "index.html"));

        assert.throws(
            () =>
                assembleRails(
                    ["v0.1.0"],
                    "v0.2.0",
                    cacheDir,
                    outDir,
                    (_rail, target) => writeCompleteRail(target),
                ),
            /rail v0\.1\.0 is incomplete/,
        );

        // Positive control: adding the missing manifest.json allows assembly to succeed.
        writeFile(path.join(cacheDir, "v0.1.0", "manifest.json"), "{}\n");
        assert.deepEqual(
            assembleRails(
                ["v0.1.0"],
                "v0.2.0",
                cacheDir,
                outDir,
                (_rail, target) => writeCompleteRail(target),
            ),
            { assembled: ["v0.1.0"], missing: [] },
        );
    });
});

suite("a rail is immutable", () => {
    const origin = "https://site.web.app";
    const preview = "https://site--rails-x-a1b2c3.web.app";
    const tag = "v1.2.3";
    let head;
    let realFetch;
    let realLog;
    let realWarn;

    /** What checkPublishedRail reported, kept for a case that wants to read it. */
    let reported;

    before(() => {
        head = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
        }).trim();
        realFetch = globalThis.fetch;
        realLog = console.log;
        realWarn = console.warn;
    });

    beforeEach(() => {
        // checkPublishedRail narrates to the terminal, because during a
        // release its marks are the record of what was checked. Here that
        // narration lands in the middle of the reporter's own output, where
        // it reads as part of the results. It is collected instead.
        reported = [];
        console.log = (...args) => reported.push(args.join(" "));
        console.warn = (...args) => reported.push(args.join(" "));
    });

    afterEach(() => {
        console.log = realLog;
        console.warn = realWarn;
    });

    after(() => {
        globalThis.fetch = realFetch;
    });

    test("an unpublished name reads as unpublished, not as an error", async () => {
        globalThis.fetch = stubFetch({ status: 404 });
        assert.equal(await publishedManifest(origin, tag), null);
        await checkPublishedRail(origin, tag, null, false);
    });

    test("returns undefined on network or 5xx errors and skips the immutability check", async () => {
        // null means the origin answered "nothing here". undefined means it
        // did not answer. Collapsing them would let an outage wave through a
        // republish of a name that is already taken.
        globalThis.fetch = stubFetch({ throws: true });
        assert.equal(await publishedManifest(origin, tag), undefined);
        globalThis.fetch = stubFetch({ status: 500 });
        assert.equal(await publishedManifest(origin, tag), undefined);
        await checkPublishedRail(origin, tag, null, false);
    });

    test("republishing the same commit under the same name is allowed", async () => {
        globalThis.fetch = stubFetch({ status: 200, body: { commit: head } });
        await checkPublishedRail(origin, tag, null, false);
    });

    test("a different commit under a published name stops a live release", async () => {
        globalThis.fetch = stubFetch({
            status: 200,
            body: { commit: "0000000000000000000000000000000000000000" },
        });
        await assert.rejects(
            () => checkPublishedRail(origin, tag, null, false),
            /is published from 0000000/,
        );
    });

    test("a manifest with no commit still stops a live release", async () => {
        globalThis.fetch = stubFetch({ status: 200, body: { tag } });
        await assert.rejects(
            () => checkPublishedRail(origin, tag, null, false),
            /an unrecorded commit/,
        );
    });

    test("a preview channel may rebuild the name, which is its purpose", async () => {
        globalThis.fetch = stubFetch({
            status: 200,
            body: { commit: "0000000000000000000000000000000000000000" },
        });
        await checkPublishedRail(preview, tag, null, false);
        await checkPublishedRail(origin, tag, "rails-x", false);
    });

    test("--republish overrides it deliberately", async () => {
        globalThis.fetch = stubFetch({
            status: 200,
            body: { commit: "0000000000000000000000000000000000000000" },
        });
        await checkPublishedRail(origin, tag, null, true);

        // Deliberately is the word that matters: the flag lets the release
        // past a rail that is already taken, so the override says on screen
        // what it is doing rather than passing in silence.
        assert.match(reported.join("\n"), /about to change content/);
    });
});

suite("webpack isolates a rail under /r/<tag>/ and shares the root across unversioned pages", () => {
    const production = { mode: "production" };

    /**
     * Filenames the HtmlWebpackPlugin instances in a config will emit.
     *
     * @param {import("webpack").Configuration} config Built configuration.
     * @returns {string[]} Emitted HTML filenames.
     */
    const htmlPages = (config) =>
        config.plugins
            .filter((plugin) => plugin.constructor.name === "HtmlWebpackPlugin")
            .map((plugin) => plugin.options.filename);

    /**
     * Whether a config emits the manifest a rail is probed by.
     *
     * @param {import("webpack").Configuration} config Built configuration.
     * @returns {boolean} True when the manifest plugin is attached.
     */
    const hasManifest = (config) =>
        config.plugins.some(
            (plugin) => plugin.constructor.name === "RailManifestPlugin",
        );

    test("a rail builds into /r/<tag>/ and resolves its assets there", () => {
        const config = makeWebpackConfig(
            { storage: "firebase", pages: "operator", rail: "v1.2.3" },
            production,
        );
        assert.equal(
            config.output.path,
            path.join(repoRoot, "dist-firebase", "r", "v1.2.3"),
        );
        assert.equal(config.output.publicPath, "/r/v1.2.3/");
        assert.deepEqual(htmlPages(config), ["operator/index.html"]);
        assert.equal(hasManifest(config), true);
    });

    test("a rail owns its own directory, so it may clean it", () => {
        const rail = makeWebpackConfig(
            { storage: "firebase", pages: "operator", rail: "v1.2.3" },
            production,
        );
        assert.equal(rail.output.clean, true);
    });

    test("a partial build at the root may not clean the tree it shares", () => {
        // The lobby and the unversioned operator page are assembled into one
        // dist-firebase/ beside the rails. A clean on either would delete
        // what was assembled before it.
        for (const pages of ["home", "operator"]) {
            const config = makeWebpackConfig(
                { storage: "firebase", pages },
                production,
            );
            assert.equal(
                config.output.clean,
                false,
                `a ${pages} build must not clean dist-firebase`,
            );
            assert.equal(config.output.path, path.join(repoRoot, "dist-firebase"));
        }
    });

    test("the lobby is the only build that emits the root page", () => {
        assert.deepEqual(
            htmlPages(
                makeWebpackConfig({ storage: "firebase", pages: "home" }, production),
            ),
            ["index.html"],
        );
        assert.equal(
            htmlPages(
                makeWebpackConfig(
                    { storage: "firebase", pages: "operator" },
                    production,
                ),
            ).includes("index.html"),
            false,
        );
    });

    test("a whole-site build still emits all three pages and cleans", () => {
        const config = makeWebpackConfig({ storage: "firebase" }, production);
        assert.deepEqual(htmlPages(config).sort(), [
            "index.html",
            "operator/index.html",
            "robot/index.html",
        ]);
        assert.equal(config.output.clean, true);
        assert.equal(hasManifest(config), false);
    });

    test("a rail may not be named anything but a release", () => {
        for (const rail of ["v1.2", "main", "v1.2.3-dirty"]) {
            assert.throws(
                () =>
                    makeWebpackConfig(
                        { storage: "firebase", pages: "operator", rail },
                        production,
                    ),
                /is not a release tag/,
                `${rail} should not name a rail`,
            );
        }
    });

    test("a rail may not be built from the localstorage bundle", () => {
        // Its assets would resolve under /local/ and 404 from /r/<tag>/.
        assert.throws(
            () =>
                makeWebpackConfig(
                    { storage: "localstorage", pages: "operator", rail: "v1.2.3" },
                    production,
                ),
            /requires --env storage=firebase/,
        );
    });

    test("an unknown page name is refused rather than silently dropped", () => {
        assert.throws(
            () => makeWebpackConfig({ storage: "firebase", pages: "lobby" }, production),
            /unknown page\(s\) lobby/,
        );
    });

    test("a rail built without --env pages=operator emits index.html and is rejected by railBundleReady", () => {
        // webpack permits --env rail without --env pages=operator; railBundleReady
        // rejects the resulting output because htmlPages(config) includes index.html.
        const config = makeWebpackConfig(
            { storage: "firebase", rail: "v1.2.3" },
            production,
        );
        const dir = tempDir("railpages");
        writeFile(path.join(dir, "manifest.json"), "{}");
        for (const page of htmlPages(config)) {
            writeFile(path.join(dir, page));
        }
        assert.equal(railBundleReady(dir), false);
    });
});

suite("the lobby bundle receives only allowlisted PUBLIC_ environment variables", () => {
    /** The two values that decide whether a lobby routes to rails at all. */
    const RAIL_KEYS = ["PUBLIC_HOSTING_ORIGIN", "PUBLIC_STABLE_RAIL"];

    /** Values this process started with, restored after each test. */
    const saved = {};

    before(() => {
        for (const key of RAIL_KEYS) saved[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of RAIL_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    test("both rail keys may enter a browser bundle", () => {
        // servesRails() and the stable rail in robotModel.ts read nothing
        // else. A key missing from this list is a lobby that serves no rails
        // however the release was built.
        for (const key of RAIL_KEYS) {
            assert.ok(
                PUBLIC_WEBPACK_ENV_KEYS.includes(key),
                `${key} cannot reach the bundle`,
            );
        }
    });

    test("a release may set them for one build without editing .env", () => {
        // deployHosting.js passes them to the child build in its environment,
        // so the process environment has to win over the file on disk.
        process.env.PUBLIC_HOSTING_ORIGIN = "https://from-env.web.app";
        process.env.PUBLIC_STABLE_RAIL = "v0.2.0";
        const definitions = webpackPublicEnvDefinitions({
            PUBLIC_HOSTING_ORIGIN: "https://from-dotenv.web.app",
            PUBLIC_STABLE_RAIL: "v0.1.0",
        });
        assert.equal(
            definitions["process.env.PUBLIC_HOSTING_ORIGIN"],
            '"https://from-env.web.app"',
        );
        assert.equal(definitions["process.env.PUBLIC_STABLE_RAIL"], '"v0.2.0"');
    });

    test("the .env file answers where the environment does not", () => {
        for (const key of RAIL_KEYS) delete process.env[key];
        const definitions = webpackPublicEnvDefinitions({
            PUBLIC_HOSTING_ORIGIN: "https://from-dotenv.web.app",
        });
        assert.equal(
            definitions["process.env.PUBLIC_HOSTING_ORIGIN"],
            '"https://from-dotenv.web.app"',
        );
    });

    test("a key neither of them sets becomes the literal undefined", () => {
        // Not the string "undefined": the lobby compares it with an origin,
        // and a preview must fail that comparison rather than match a site
        // that happens to be named for it.
        for (const key of RAIL_KEYS) delete process.env[key];
        const definitions = webpackPublicEnvDefinitions({});
        for (const key of RAIL_KEYS) {
            assert.equal(definitions[`process.env.${key}`], "undefined");
        }
    });

    test("values are injected as quoted literals, not as bare text", () => {
        process.env.PUBLIC_STABLE_RAIL = "v0.2.0";
        const definitions = webpackPublicEnvDefinitions({});
        assert.equal(definitions["process.env.PUBLIC_STABLE_RAIL"], '"v0.2.0"');
    });

    test("a build carries them into the bundle through DefinePlugin", () => {
        // The plugin list is where the two leave the release scripts and
        // become part of the lobby.
        const config = makeWebpackConfig(
            { storage: "firebase", pages: "home" },
            { mode: "production" },
        );
        const define = config.plugins.find(
            (plugin) => plugin.constructor.name === "DefinePlugin",
        );
        assert.ok(define, "no DefinePlugin in the lobby build");
        for (const key of RAIL_KEYS) {
            assert.ok(
                `process.env.${key}` in define.definitions,
                `${key} is not defined for the bundle`,
            );
        }
    });
});
