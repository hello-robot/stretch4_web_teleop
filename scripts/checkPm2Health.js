#!/usr/bin/env node
// Confirm pm2 processes stay up through a settle window.
//
// pm2 start returns as soon as it has spawned a process, so a server.js that
// throws on startup -- a bad certificate, port 443 already taken -- passes as
// started, and pm2 then restarts it quietly in the background. The operator
// page just sits on its loading screen. This catches that at launch time.
//
// Usage: checkPm2Health.js <pm2-name> [...]
//
// A process fails when it is missing, not online, or restarted during the
// window. Restarts are counted against a snapshot taken at the start, so a
// process that was already running with old restarts is not blamed for them.
//
// Exits 0 when every process is healthy, 1 otherwise, printing the tail of
// each failed process's logs.

const { execFileSync } = require("child_process");
const fs = require("fs");

const names = process.argv.slice(2);
const settleMs = Number(process.env.WEB_TELEOP_PM2_SETTLE_MS || 5000);
const tailLines = 20;

if (names.length === 0) {
    console.error("Usage: checkPm2Health.js <pm2-name> [...]");
    process.exit(1);
}

// pm2 jlist prints the process list as one JSON line, but can print daemon
// chatter around it, so take the first line that parses as an array.
function listProcesses() {
    let output;
    try {
        output = execFileSync("pm2", ["jlist"], { encoding: "utf8" });
    } catch (error) {
        console.error(`[PM2 HEALTH] pm2 jlist failed: ${error.message}`);
        process.exit(1);
    }
    for (const line of output.split("\n")) {
        try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) {
                return new Map(parsed.map((p) => [p.name, p]));
            }
        } catch {
            // Not the JSON line.
        }
    }
    console.error("[PM2 HEALTH] Could not parse pm2 jlist output.");
    process.exit(1);
}

function tail(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
    return lines.slice(-tailLines).join("\n");
}

function printLogs(proc) {
    const env = proc.pm2_env || {};
    for (const [label, file] of [
        ["stderr", env.pm_err_log_path],
        ["stdout", env.pm_out_log_path],
    ]) {
        const text = tail(file);
        if (!text) continue;
        console.error(`  Last ${label} (${file}):`);
        console.error(text.replace(/^/gm, "    "));
    }
}

const before = listProcesses();

setTimeout(() => {
    const after = listProcesses();
    let failed = false;

    for (const name of names) {
        const proc = after.get(name);
        if (!proc) {
            console.error(`[PM2 HEALTH] ${name}: not running under pm2.`);
            failed = true;
            continue;
        }
        const env = proc.pm2_env || {};
        const restartsBefore = before.get(name)?.pm2_env?.restart_time ?? 0;
        const restarts = (env.restart_time ?? 0) - restartsBefore;
        if (env.status !== "online" || restarts > 0) {
            console.error(
                `[PM2 HEALTH] ${name}: status ${env.status}, ` +
                    `${restarts} restart(s) in ${settleMs / 1000}s -- it is crashing.`
            );
            printLogs(proc);
            failed = true;
        }
    }

    if (failed) process.exit(1);
    console.log(`[PM2 HEALTH] Healthy: ${names.join(", ")}`);
}, settleMs);
