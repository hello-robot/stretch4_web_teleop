#!/usr/bin/env node

/**
 * Keep .firebaserc's default project in step with projectId in .env.
 *
 * projectId is entered once, in .env, where webpack already reads it. The
 * Firebase CLI cannot read it from there: needProjectId() resolves only from
 * --project or .firebaserc aliases, with no environment fallback. So .firebaserc
 * is generated from .env rather than maintained by hand, which keeps bare
 * `firebase <command>` calls working off a single source of truth.
 *
 * Only projects.default is touched. Aliases, targets, and etags the CLI or a
 * human added are preserved, so `firebase use --add staging` survives a sync.
 *
 * No projectId in .env means this deployment is local-only; that is not an
 * error and nothing is written.
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const repoRoot = path.join(__dirname, "..");
const rcPath = path.join(repoRoot, ".firebaserc");

/**
 * Read the configured Firebase project ID from `.env` or `process.env`.
 *
 * @param {string} [root] Repository root containing `.env`.
 * @returns {string} Project ID from `.env` or environment, or `""` when absent.
 */
function envProjectId(root = repoRoot) {
    const parsed =
        dotenv.config({ path: path.join(root, ".env") }).parsed || {};
    // A release runner has no .env; its values arrive as environment entries.
    const value =
        parsed.PUBLIC_FIREBASE_PROJECT_ID ||
        process.env.PUBLIC_FIREBASE_PROJECT_ID ||
        "";
    return value.trim();
}

/**
 * Parse `.firebaserc` from disk.
 *
 * @param {string} [file] Path to `.firebaserc`.
 * @returns {Record<string, unknown>} Parsed `.firebaserc`, or `{}` when missing or invalid.
 */
function readRc(file = rcPath) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        // Missing or malformed .firebaserc is treated as empty and overwritten on sync.
        return {};
    }
}

/**
 * Synchronize `projects.default` in `.firebaserc` with `projectId`, preserving other keys.
 *
 * @param {string} projectId Target Firebase project ID.
 * @param {string} [file] Path to `.firebaserc`.
 * @returns {"unchanged" | "written" | "skipped"} Sync outcome.
 */
function syncFirebaseRc(projectId, file = rcPath) {
    if (!projectId) return "skipped";
    const rc = readRc(file);
    if (rc.projects && rc.projects.default === projectId) return "unchanged";
    rc.projects = { ...rc.projects, default: projectId };
    fs.writeFileSync(file, `${JSON.stringify(rc, null, 2)}\n`);
    return "written";
}

module.exports = { envProjectId, readRc, syncFirebaseRc };

if (require.main === module) {
    const projectId = envProjectId();
    const result = syncFirebaseRc(projectId);
    if (result === "written") {
        console.log(`.firebaserc now points at ${projectId}`);
    }
}
