/**
 * The decision logic of the multi-rail hosting backend, exercised offline.
 *
 * Every case here runs without a network, without Firebase credentials and
 * without a webpack build, so the whole file is a gate that can run anywhere.
 * What it covers is the part of a release that decides *what* is published:
 * the tag grammar, the flags, the origin and channel resolution, the bundle
 * guards, the immutability check, and the webpack wiring that puts a rail
 * under /r/<tag>/.
 *
 * What it deliberately does not cover, because neither can be decided without
 * a Hosting site: the server-side clone in hostingVersion.js, and the lobby's
 * runtime routing in the browser. Those are test/rails/hosting-routes.test.mjs
 * and the manual stages in test/rails/README.md.
 *
 * Run through `npm run test:rails`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";

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
    servedFiles,
    siteFromOrigin,
} = require("../../scripts/hostingVersion");
const {
    checkPublishedRail,
    isPreviewOrigin,
    parseArgs,
    previewChannelId,
    publishedManifest,
} = require("../../scripts/deployHosting");
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

/**
 * Create an empty directory under the OS temp root.
 *
 * @param {string} label Prefix that names what the directory is for.
 * @returns {string} Absolute path to the new directory.
 */
function tempDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `rails-${label}-`));
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

describe("the rail tag grammar", () => {
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

describe("release.json", () => {
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

describe("deploy flags", () => {
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

describe("the preview channel a checkout publishes to", () => {
    test("folds a branch name into something Hosting accepts", () => {
        assert.equal(branchSlug("feature/multi-rail"), "feature-multi-rail");
        assert.equal(branchSlug("a_b:c#d"), "a-b-c-d");
    });

    test("is named for this checkout, under the rails- prefix", () => {
        const id = previewChannelId();
        assert.match(id, /^rails-[A-Za-z0-9_-]+$/);
        assert.ok(id.length <= 63, `channel id is ${id.length} characters`);
        // The prefix is what keeps a rails preview clear of the branch-<slug>
        // channel a robot's autodeploy owns; they carry different trees.
        assert.ok(!id.startsWith("rails-branch-"));
    });
});

describe("telling a preview origin from the live site", () => {
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

describe("naming the Hosting site behind an origin", () => {
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

describe("the file set a version publishes", () => {
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

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
});

describe("the serving config a version is finalized with", () => {
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
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("the guards on an assembled tree", () => {
    let dir;

    before(() => (dir = tempDir("bundles")));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

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

describe("a rail is immutable", () => {
    const origin = "https://site.web.app";
    const preview = "https://site--rails-x-a1b2c3.web.app";
    const tag = "v1.2.3";
    let head;
    let realFetch;

    before(() => {
        head = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
        }).trim();
        realFetch = globalThis.fetch;
    });

    after(() => {
        globalThis.fetch = realFetch;
    });

    test("an unpublished name reads as unpublished, not as an error", async () => {
        globalThis.fetch = stubFetch({ status: 404 });
        assert.equal(await publishedManifest(origin, tag), null);
        await checkPublishedRail(origin, tag, null, false);
    });

    test("a fault that says nothing is not read as unpublished", async () => {
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
    });
});

describe("how webpack places a rail", () => {
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

    test("a rail built with the whole page set is caught by the tree guard", () => {
        // webpack permits it: --env rail only moves the output. What stops it
        // reaching the site is railBundleReady, which refuses a rail carrying
        // a root page. This records that the pair is the guard, not the
        // webpack config alone.
        const config = makeWebpackConfig(
            { storage: "firebase", rail: "v1.2.3" },
            production,
        );
        assert.ok(htmlPages(config).includes("index.html"));

        const dir = tempDir("railpages");
        writeFile(path.join(dir, "operator", "index.html"));
        writeFile(path.join(dir, "manifest.json"), "{}");
        writeFile(path.join(dir, "index.html"));
        assert.equal(railBundleReady(dir), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
