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

const repoRoot = path.join(__dirname, "..");

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
