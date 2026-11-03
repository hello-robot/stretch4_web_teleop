#!/usr/bin/env node

/**
 * checkFirebaseRobotAccess.js
 *
 * Firebase signaling preflight. Signs in with the robot account from .env and
 * reads assignments/<uid> -- what the robot page and the teleop lease do
 * moments later.
 *
 * Scope: the Firebase CLI credential is not consulted. It uploads Hosting and
 * does not affect signaling.
 *
 * Exit codes. Callers separate 2 from 3: a launch that did not ask for Firebase
 * reports 3 and passes over 2. Every failing case writes its cause to stderr.
 *
 *   0  Signaling can work now. Every key in FIREBASE_KEYS and HELLO_FLEET_ID
 *      are set, the robot account signed in, and assignments/<uid> carries
 *      role "robot" and this fleet's name.
 *
 *   2  Not set up for Firebase. No key in FIREBASE_KEYS is set, in .env or in
 *      the environment. Produced by a fresh checkout, an .env with no Firebase
 *      section, and a missing .env.
 *
 *   3  Set up and not working. At least one key in FIREBASE_KEYS is set and a
 *      later step failed:
 *        - some keys set and others missing, or HELLO_FLEET_ID unset
 *        - firebase/app, firebase/auth or firebase/database cannot be
 *          required, meaning node_modules is missing or incomplete
 *        - sign-in rejected: ROBOT_PASSWORD wrong, ROBOT_USERNAME absent from
 *          the project, or PUBLIC_FIREBASE_API_KEY belonging to another project
 *        - sign-in or the assignments read exceeding
 *          WEB_TELEOP_FIREBASE_PROBE_TIMEOUT_MS, which an unreachable network
 *          and a wrong PUBLIC_FIREBASE_DATABASE_URL both produce
 *        - assignments/<uid> rejected by the database rules
 *        - assignments/<uid> absent, role not "robot", or name not matching
 *          HELLO_FLEET_ID: onboarding did not finish, or this account is bound
 *          to another fleet
 *
 * Any other non-zero code comes from node rather than this script and means the
 * probe could not run. Callers treat it as 3.
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

    // Required here rather than at module scope: the checks above must run on
    // a checkout with no node_modules, so an unconfigured robot exits 2 instead
    // of on a missing module.
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
