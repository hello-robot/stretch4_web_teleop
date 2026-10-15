#!/usr/bin/env node

/**
 * Hosting predeploy gate for the live site.
 *
 * firebase deploy (including --only hosting) uploads the live channel.
 * That proceeds only when hostingChannel() is live: clean main whose
 * HEAD equals origin/main.
 *
 * hosting:channel:deploy runs this same hook. The CLI already rejects a
 * channel id of "live", so that command is allowed. If the parent
 * command cannot be identified as a channel deploy, refuse.
 */

const fs = require("fs");
const path = require("path");
const { hostingChannel } = require("./hostingChannel");
const { envProjectId } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");

/**
 * The CLI resolved its project from .firebaserc before this hook ran, so a
 * stale file cannot be corrected here -- only caught. Aborting in predeploy
 * still stops the upload, which is the part that matters: otherwise one
 * project's interface is published over another project's data.
 */
function requireMatchingProject() {
    const fromEnv = envProjectId();
    if (!fromEnv) return;
    let fromRc;
    try {
        fromRc = JSON.parse(
            fs.readFileSync(path.join(repoRoot, ".firebaserc"), "utf8"),
        ).projects?.default;
    } catch {
        fromRc = undefined;
    }
    if (fromRc !== fromEnv) {
        console.error(
            `.firebaserc targets ${fromRc ?? "no project"} but .env projectId is ${fromEnv}.\n` +
                "Run: node scripts/syncFirebaseRc.js",
        );
        process.exit(1);
    }
}

function cmdline(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
        return "";
    }
}

function ppid(pid) {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const match = status.match(/^PPid:\s+(\d+)/m);
        return match ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}

function ancestorCommand() {
    const lines = [];
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 1; i += 1) {
        const line = cmdline(pid);
        if (line) lines.push(line);
        pid = ppid(pid);
    }
    return lines.join("\n");
}

requireMatchingProject();

const ancestors = ancestorCommand();
if (ancestors.includes("hosting:channel:deploy")) {
    process.exit(0);
}

let channel;
try {
    channel = hostingChannel(repoRoot);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

if (!channel.live) {
    console.error(
        `Refusing to publish the live site. This checkout is ${channel.id}, not clean origin/main.`,
    );
    process.exit(1);
}
