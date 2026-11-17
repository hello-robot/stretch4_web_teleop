/**
 * runHostingRoutes.mjs
 *
 * Stand the Firebase Hosting emulator up over a multi-rail tree and run
 * test/hosting/hosting-routes.test.mjs against it.
 *
 * The emulator is given a configuration derived from the repository's own
 * firebase.json -- the same headers, the same ignore list -- with only the
 * served directory and the emulator ports replaced. A header rule that is
 * wrong in firebase.json is therefore wrong here, which is the point.
 *
 * By default it builds a small fixture tree, so the routing can be checked in
 * seconds with no webpack build and no Firebase credentials. Point it at a
 * real assembled tree to check the thing a release would actually publish:
 *
 *   node test/hosting/runHostingRoutes.mjs
 *   node test/hosting/runHostingRoutes.mjs --tree dist-firebase --rail v0.1.0
 *
 * A demo project id is used throughout, so nothing here can reach, read or
 * write a real Firebase project.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
);

/** Rail the fixture tree publishes when no real tree is given. */
const FIXTURE_RAIL = "v1.2.3";

/** Project the emulator runs as. The demo- prefix cannot reach a real one. */
const DEMO_PROJECT = "demo-rails";

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{tree: string|null, rail: string|null}} Tree to serve and the rail
 *     to probe within it, or nulls when the fixture should be built.
 * @throws {Error} When an argument is not recognised or has no value.
 */
function parseArgs(argv) {
    const options = { tree: null, rail: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--tree") options.tree = argv[++i];
        else if (argv[i] === "--rail") options.rail = argv[++i];
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (options.tree && !options.rail) {
        throw new Error("--tree needs --rail to say which rail to probe");
    }
    return options;
}

/**
 * A TCP port nothing is listening on.
 *
 * Asked for rather than fixed, so a run does not collide with an emulator or
 * a dev server the practitioner already has up.
 *
 * @returns {Promise<number>} A free port on the loopback interface.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Write a file, creating the directories above it.
 *
 * @param {string} file Absolute path to write.
 * @param {string} body Contents.
 * @returns {void}
 */
function writeFile(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/**
 * Build the smallest tree that has the shape of a published version: a lobby
 * at the root, an unversioned operator page, and one rail with the manifest
 * it is probed by.
 *
 * @param {string} dir Directory to build the tree in.
 * @param {string} rail Tag the fixture rail is published under.
 * @returns {void}
 */
function buildFixtureTree(dir, rail) {
    writeFile(path.join(dir, "index.html"), "<!doctype html><title>lobby</title>");
    writeFile(
        path.join(dir, "operator", "index.html"),
        "<!doctype html><title>operator</title>",
    );
    writeFile(
        path.join(dir, "r", rail, "operator", "index.html"),
        `<!doctype html><title>operator ${rail}</title>`,
    );
    writeFile(
        path.join(dir, "r", rail, "manifest.json"),
        `${JSON.stringify(
            {
                tag: rail,
                commit: "0".repeat(40),
                describe: rail,
                built: new Date().toISOString(),
            },
            null,
            2,
        )}\n`,
    );
    writeFile(path.join(dir, "r", rail, "operator", "bundle.js"), "// fixture\n");
    writeFile(path.join(dir, "r", rail, "415", "bundle.js"), "// chunk fixture\n");
    writeFile(
        path.join(dir, "r", rail, "09feeb2dab41b0e57c1d9964af896a01.svg"),
        "<svg></svg>\n",
    );
}

/**
 * Derive an emulator configuration from the repository's firebase.json.
 *
 * The predeploy hook and the database block are dropped: neither applies to a
 * hosting emulator, and the hook would refuse a tree that is not a release
 * checkout. Everything that decides how a file is served is kept as it is.
 *
 * The served directory is written relative to the configuration file. The
 * emulator serves nothing at all from an absolute hosting.public, and says so
 * only by answering 404 to every path.
 *
 * @param {string} configDir Directory the derived config is written to.
 * @param {string} servedDir Directory the emulator serves.
 * @param {number} port Port the emulator listens on.
 * @returns {string} Path to the derived configuration file.
 */
function deriveConfig(configDir, servedDir, port) {
    const config = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "firebase.json"), "utf8"),
    );
    delete config.database;
    delete config.hosting.predeploy;
    config.hosting.public = path.relative(configDir, servedDir);
    config.emulators = {
        hosting: { port },
        ui: { enabled: false },
        singleProjectMode: true,
    };
    const file = path.join(configDir, "firebase.json");
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return file;
}

/**
 * Run the trials against a tree.
 *
 * @returns {Promise<number>} Exit status to leave the process with.
 */
async function main() {
    const options = parseArgs(process.argv.slice(2));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rails-hosting-"));

    let servedDir;
    let rail;
    if (options.tree) {
        servedDir = path.resolve(repoRoot, options.tree);
        rail = options.rail;
        const manifest = path.join(servedDir, "r", rail, "manifest.json");
        if (!fs.existsSync(manifest)) {
            throw new Error(
                `${servedDir} publishes no rail ${rail}: ${manifest} is missing.\n` +
                    "Assemble one first with: npm run deploy:hosting -- --dry-run",
            );
        }
    } else {
        servedDir = path.join(workDir, "tree");
        rail = FIXTURE_RAIL;
        buildFixtureTree(servedDir, rail);
    }

    const port = await freePort();
    const config = deriveConfig(workDir, servedDir, port);
    const origin = `http://127.0.0.1:${port}`;

    console.log(`Serving ${servedDir} at ${origin} (rail ${rail})`);

    const result = spawnSync(
        path.join(repoRoot, "node_modules", ".bin", "firebase"),
        [
            "emulators:exec",
            "--only",
            "hosting",
            "--project",
            DEMO_PROJECT,
            "--config",
            config,
            `node --test ${path.join(repoRoot, "test", "hosting", "hosting-routes.test.mjs")}`,
        ],
        {
            cwd: repoRoot,
            stdio: "inherit",
            env: {
                ...process.env,
                CHOKIDAR_USEPOLLING: "1",
                RAIL_TEST_ORIGIN: origin,
                RAIL_TEST_TAG: rail,
            },
        },
    );

    fs.rmSync(workDir, { recursive: true, force: true });
    return result.status ?? 1;
}

main().then(
    (status) => process.exit(status),
    (error) => {
        console.error(error.message);
        process.exit(1);
    },
);
