/**
 * runDatabaseRules.mjs
 *
 * Stand the Firebase Realtime Database emulator up on an ephemeral port and
 * run test/security/firebase-database-rules.test.mjs against it.
 *
 * Allocating a free port per run avoids colliding with an emulator already
 * bound to port 9000, and omitting `database.rules` from the derived emulator
 * config avoids opening an inotify file watcher (the test suite uploads
 * database.rules.json directly via initializeTestEnvironment).
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

/** Demo project id used by test/security/firebase-database-rules.test.mjs. */
const DEMO_PROJECT = "demo-interface-rules";

/**
 * Allocate an unused loopback TCP port.
 *
 * @returns {Promise<number>} A free port on 127.0.0.1.
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
 * Write a minimal temporary firebase.json configuring the database emulator.
 *
 * @param {string} configDir Temporary directory to write firebase.json in.
 * @param {number} port Ephemeral TCP port for the database emulator.
 * @returns {string} Path to the written configuration file.
 */
function writeEmulatorConfig(configDir, port) {
    const config = {
        emulators: {
            database: {
                host: "127.0.0.1",
                port,
            },
            ui: {
                enabled: false,
            },
            singleProjectMode: true,
        },
    };
    const file = path.join(configDir, "firebase.json");
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return file;
}

/**
 * Launch the database emulator and run the security rules suite.
 *
 * @returns {Promise<number>} Process exit status.
 */
async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-rules-"));
    try {
        const port = await freePort();
        const config = writeEmulatorConfig(workDir, port);
        const testFile = path.join(
            repoRoot,
            "test",
            "security",
            "firebase-database-rules.test.mjs",
        );

        const result = spawnSync(
            path.join(repoRoot, "node_modules", ".bin", "firebase"),
            [
                "emulators:exec",
                "--only",
                "database",
                "--project",
                DEMO_PROJECT,
                "--config",
                config,
                `node --test ${testFile}`,
            ],
            {
                cwd: repoRoot,
                stdio: "inherit",
                env: {
                    ...process.env,
                    CHOKIDAR_USEPOLLING: "1",
                },
            },
        );
        return result.status ?? 1;
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

main().then(
    (status) => process.exit(status),
    (error) => {
        console.error(error.message);
        process.exit(1);
    },
);
