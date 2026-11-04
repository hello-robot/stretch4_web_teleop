#!/usr/bin/env node

/**
 * prototypeCloneAdd.js
 *
 * EXPERIMENT. Not part of any release path.
 *
 * Tests whether a Hosting version can be published additively: clone the
 * version a channel is serving, add files to the clone, finalize, release.
 * If that works, publishing a rail stops needing a local copy of every rail
 * already deployed -- the old ones are carried across server side.
 *
 * The open question it answers is whether :populateFiles is accepted against
 * a cloned version that was not finalized. Everything else is already known:
 * populateFiles accumulates, because the CLI calls it in batches of 1000
 * against one version.
 *
 * Usage:
 *   node scripts/prototypeCloneAdd.js --site <siteId> --to clone-add-test \
 *       --add dist-firebase/r/v0.9.9-rc1 --prefix /r/v0.9.9-rc1
 *
 *   --from <channel>  version to clone from (default: live)
 *   --expect <path>   a path that must survive the clone, e.g. /index.html
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const {
    getChannel,
    createChannel,
    cloneVersion,
    updateVersion,
    createRelease,
} = require("firebase-tools/lib/hosting/api");
const { Client } = require("firebase-tools/lib/apiv2");
const { hostingApiOrigin } = require("firebase-tools/lib/api");
const { selectAccount, setActiveAccount } = require("firebase-tools/lib/auth");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

/**
 * Load the signed-in account the way the CLI does before a command runs.
 *
 * requireAuth reads options.user and options.tokens; the Command framework
 * fills those from the credential store first. Requiring the API modules
 * directly skips that, and the only symptom is "not yet authenticated" from
 * the first call, however recently you logged in.
 *
 * @returns {Promise<void>} Resolves once a token can be issued.
 * @throws {Error} When no account is stored, or its tokens cannot refresh.
 */
async function authenticate() {
    const account = selectAccount(undefined, process.cwd());
    if (!account) {
        throw new Error(
            "no signed-in account found. Run: ./node_modules/.bin/firebase login",
        );
    }
    const options = {};
    setActiveAccount(options, account);
    await requireAuth(options);
    console.log(`[0] authenticated as ${account.user?.email ?? "stored account"}`);
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Record<string, string>} Parsed options.
 */
function parseArgs(argv) {
    const options = { from: "live", to: null, site: null, add: null, prefix: null, expect: "/index.html" };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, "");
        if (!(key in options)) throw new Error(`unknown argument: ${argv[i]}`);
        options[key] = argv[++i];
    }
    for (const required of ["site", "to", "add", "prefix"]) {
        if (!options[required]) throw new Error(`--${required} is required`);
    }
    return options;
}

/**
 * Every file under a directory, as served paths mapped to local paths.
 *
 * @param {string} dir Directory to walk.
 * @param {string} prefix Served path the directory maps to.
 * @returns {Record<string, string>} Served path to local path.
 */
function filesUnder(dir, prefix) {
    const found = {};
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const local = path.join(current, entry.name);
            if (entry.isDirectory()) walk(local);
            else if (entry.isFile()) {
                const served = `${prefix}/${path.relative(dir, local)}`.replace(/\/+/g, "/");
                found[served] = local;
            }
        }
    };
    walk(dir);
    return found;
}

/**
 * Hosting's content hash: SHA256 of the gzipped bytes.
 *
 * @param {string} file Local path.
 * @returns {{hash: string, body: Buffer}} Hash and the gzipped content.
 */
function contentHash(file) {
    const body = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
    return { hash: crypto.createHash("sha256").update(body).digest("hex"), body };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await authenticate();
    const api = new Client({ urlPrefix: hostingApiOrigin(), apiVersion: "v1beta1", auth: true });

    console.log(`[1] reading channel ${options.from} on site ${options.site}`);
    const source = await getChannel("-", options.site, options.from);
    const sourceVersion = source?.release?.version?.name;
    if (!sourceVersion) throw new Error(`channel ${options.from} is serving no version`);
    console.log(`    source version: ${sourceVersion}`);

    console.log("[2] cloning it WITHOUT finalizing");
    const cloned = await cloneVersion(options.site, sourceVersion, false);
    const version = cloned?.name;
    if (!version) throw new Error("clone returned no version name");
    console.log(`    clone: ${version} (status ${cloned.status})`);

    const files = filesUnder(options.add, options.prefix);
    const hashes = {};
    const bodies = {};
    for (const [served, local] of Object.entries(files)) {
        const { hash, body } = contentHash(local);
        hashes[served] = hash;
        bodies[hash] = body;
    }
    console.log(`[3] populating ${Object.keys(hashes).length} added files into the clone`);
    const populated = await api.post(`/${version}:populateFiles`, { files: hashes });
    const required = populated.body.uploadRequiredHashes ?? [];
    console.log(`    server wants ${required.length} of them uploaded`);

    if (required.length > 0) {
        const uploader = new Client({ urlPrefix: populated.body.uploadUrl, auth: true });
        for (const hash of required) {
            await uploader.request({ method: "POST", path: `/${hash}`, body: bodies[hash] });
        }
        console.log("    uploaded");
    }

    console.log("[4] finalizing and releasing to " + options.to);
    await updateVersion(options.site, version.split("/").pop(), { status: "FINALIZED" });
    // A release needs its target to exist; hosting:channel:deploy creates one
    // on the way past, and this does not.
    if (!(await getChannel("-", options.site, options.to))) {
        console.log(`    channel ${options.to} does not exist; creating it`);
        await createChannel("-", options.site, options.to);
    }
    await createRelease(options.site, options.to, version);

    const channel = await getChannel("-", options.site, options.to);
    const url = channel?.url;
    console.log(`[5] verifying at ${url}`);
    for (const [label, servedPath] of [
        ["carried over by the clone", options.expect],
        ["added by populateFiles  ", Object.keys(files)[0]],
    ]) {
        const res = await fetch(`${url}${servedPath}`, { cache: "no-store" });
        console.log(`    ${label}: ${servedPath} -> ${res.status}`);
    }
}

main().catch((error) => {
    console.error(`FAILED: ${error.message}`);
    process.exit(1);
});
