#!/usr/bin/env node

/**
 * checkFirebaseRobotAccess.js
 *
 * Firebase signaling preflight. Signs in with the robot account from .env and
 * reads assignments/<uid> -- exactly what the robot page and the teleop lease
 * do moments later.
 *
 * The exit code separates two conditions a launch must treat very differently:
 *
 *   0  Firebase signaling can work on this robot right now.
 *   2  No Firebase credentials in .env at all. Nobody has ever set this robot
 *      up for Firebase, so nothing is broken and a default launch has nothing
 *      worth reporting.
 *   3  Credentials are present and something is wrong -- the install, the
 *      account, the binding, or the network. Somebody started this, so even a
 *      launch that never asked for Firebase should say so.
 *
 * The Firebase CLI credential is deliberately not consulted. That credential
 * uploads Hosting and has no bearing on signaling.
 */

const fs = require("fs");
const path = require("path");

const EXIT_READY = 0;
const EXIT_NOT_CONFIGURED = 2;
const EXIT_BROKEN = 3;

const ENV_FILE = path.join(__dirname, "../.env");

const TIMEOUT_MS = Number(
    process.env.WEB_TELEOP_FIREBASE_PROBE_TIMEOUT_MS || 15000,
);

// Setting any of these is what makes a robot "set up for Firebase". None of
// them set means nobody has ever tried.
const FIREBASE_KEYS = [
    "PUBLIC_FIREBASE_API_KEY",
    "PUBLIC_FIREBASE_AUTH_DOMAIN",
    "PUBLIC_FIREBASE_DATABASE_URL",
    "PUBLIC_FIREBASE_PROJECT_ID",
    "ROBOT_USERNAME",
    "ROBOT_PASSWORD",
];

/**
 * Parse a .env file without dotenv, so this probe still runs on a checkout
 * whose node_modules is missing or broken.
 *
 * @param {string} file Path to the .env file.
 * @returns {Object<string, string>} Parsed keys, empty when the file is absent.
 */
function readEnvFile(file) {
    const values = {};
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return values;
    }
    for (const line of text.split("\n")) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
    return values;
}

/**
 * Race a Firebase call against a deadline. An unreachable Realtime Database
 * queues work instead of rejecting, so without this the probe would hang for
 * as long as the launch is willing to wait.
 *
 * @param {Promise<any>} promise Firebase call to bound.
 * @param {string} label Name used in the timeout message.
 * @returns {Promise<any>} The call's result, or a rejection at the deadline.
 */
function withTimeout(promise, label) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
            TIMEOUT_MS,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Exit with a reason on stderr.
 *
 * @param {number} code Process exit code, EXIT_NOT_CONFIGURED or EXIT_BROKEN.
 * @param {string} message Reason, printed to stderr.
 */
function fail(code, message) {
    console.error(message);
    process.exit(code);
}

async function main() {
    // The process environment wins over .env, matching dotenv's own precedence
    // and letting one launch be overridden without editing the file.
    const fileEnv = readEnvFile(ENV_FILE);
    const env = {};
    for (const key of [...FIREBASE_KEYS, "HELLO_FLEET_ID"]) {
        env[key] = process.env[key] || fileEnv[key] || "";
    }

    const present = FIREBASE_KEYS.filter((key) => env[key]);
    if (present.length === 0) {
        fail(
            EXIT_NOT_CONFIGURED,
            "No Firebase credentials in .env; this robot is not set up for Firebase.",
        );
    }

    const missing = FIREBASE_KEYS.filter((key) => !env[key]);
    if (missing.length > 0) {
        fail(EXIT_BROKEN, `.env is missing: ${missing.join(", ")}`);
    }
    if (!env.HELLO_FLEET_ID) {
        fail(EXIT_BROKEN, "HELLO_FLEET_ID is not set.");
    }

    // Required lazily: everything above has to work on a checkout with no
    // node_modules, so that a robot which never touched Firebase exits 2
    // rather than dying on a missing module.
    let initializeApp, getAuth, signInWithEmailAndPassword, getDatabase, ref, get;
    try {
        ({ initializeApp } = require("firebase/app"));
        ({ getAuth, signInWithEmailAndPassword } = require("firebase/auth"));
        ({ getDatabase, ref, get } = require("firebase/database"));
    } catch (error) {
        fail(
            EXIT_BROKEN,
            `Firebase packages are not installed: ${error.message}\n` +
                "Run 'npm install --force' to install dependencies.",
        );
    }

    const fleetId = env.HELLO_FLEET_ID;
    const app = initializeApp({
        apiKey: env.PUBLIC_FIREBASE_API_KEY,
        authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
        databaseURL: env.PUBLIC_FIREBASE_DATABASE_URL,
        projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
    });
    const auth = getAuth(app);
    const db = getDatabase(app);

    let credential;
    try {
        credential = await withTimeout(
            signInWithEmailAndPassword(
                auth,
                env.ROBOT_USERNAME,
                env.ROBOT_PASSWORD,
            ),
            "robot sign-in",
        );
    } catch (error) {
        fail(EXIT_BROKEN, `robot sign-in failed: ${error.message}`);
    }

    const uid = credential.user.uid;
    let assignment;
    try {
        const snapshot = await withTimeout(
            get(ref(db, `assignments/${uid}`)),
            `assignments/${uid} read`,
        );
        assignment = snapshot.val();
    } catch (error) {
        fail(EXIT_BROKEN, `assignments/${uid} unreadable: ${error.message}`);
    }

    if (
        !assignment ||
        assignment.role !== "robot" ||
        assignment.name !== fleetId
    ) {
        fail(
            EXIT_BROKEN,
            `robot account is not provisioned for ${fleetId}. ` +
                "Re-run ./onboard_firebase_robot.sh",
        );
    }

    console.log(`Firebase signaling ready for ${fleetId}.`);
    // The Realtime Database connection keeps the event loop alive on its own.
    process.exit(EXIT_READY);
}

main().catch((error) => fail(EXIT_BROKEN, error.message));
