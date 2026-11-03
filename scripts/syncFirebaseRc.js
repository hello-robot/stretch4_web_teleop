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
 * @returns {string} projectId from .env, or "" when it is absent
 */
function envProjectId() {
    const parsed =
        dotenv.config({ path: path.join(repoRoot, ".env") }).parsed || {};
    return (parsed.PUBLIC_FIREBASE_PROJECT_ID || "").trim();
}

/**
 * @returns {object} parsed .firebaserc, or an empty object when missing/invalid
 */
function readRc() {
    try {
        return JSON.parse(fs.readFileSync(rcPath, "utf8"));
    } catch {
        return {};
    }
}

/**
 * @param {string} projectId
 * @returns {"unchanged" | "written" | "skipped"}
 */
function syncFirebaseRc(projectId) {
    if (!projectId) return "skipped";
    const rc = readRc();
    if (rc.projects && rc.projects.default === projectId) return "unchanged";
    rc.projects = { ...rc.projects, default: projectId };
    fs.writeFileSync(rcPath, `${JSON.stringify(rc, null, 2)}\n`);
    return "written";
}

module.exports = { envProjectId, syncFirebaseRc };

if (require.main === module) {
    const projectId = envProjectId();
    const result = syncFirebaseRc(projectId);
    if (result === "written") {
        console.log(`.firebaserc now points at ${projectId}`);
    }
}
