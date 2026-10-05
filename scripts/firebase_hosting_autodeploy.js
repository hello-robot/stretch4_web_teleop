#!/usr/bin/env node

/**
 * firebase_hosting_autodeploy.js
 *
 * After webpack watch goes quiet for one second, upload dist-firebase/.
 * The current checkout goes to a preview channel. Onboard runtime builds
 * never update the live site; production Hosting is an explicit release.
 * Trailing edge only.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { hostingChannel } = require("./hostingChannel");
const { hostingBundleReady } = require("./hostingBundleReady");

const DEBOUNCE_MS = 1000;
const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

let debounceTimer = null;
let deploying = false;
let deployAgain = false;

function runFirebase(args) {
    return new Promise((resolve) => {
        const child = spawn(firebaseBin, args, { cwd: repoRoot, stdio: "inherit" });
        child.on("close", (code) => resolve(code));
    });
}

async function runDeploy() {
    deploying = true;
    let channel;
    try {
        channel = hostingChannel(repoRoot);
    } catch (err) {
        console.error(`[AUTODEPLOY] ${err.message}`);
        deploying = false;
        return;
    }

    console.log(`[AUTODEPLOY] Deploying preview channel ${channel.id}...`);
    const previewCode = await runFirebase([
        "hosting:channel:deploy",
        channel.id,
        "--expires",
        "30d",
    ]);
    if (previewCode !== 0) {
        console.error(`[AUTODEPLOY] Preview deploy failed (exit ${previewCode}).`);
    }

    deploying = false;
    if (!deployAgain) {
        return;
    }
    deployAgain = false;
    onQuiet();
}

function onQuiet() {
    if (deploying) {
        deployAgain = true;
        return;
    }
    if (!hostingBundleReady(distDir)) {
        console.warn("[AUTODEPLOY] Pages are missing. Not uploading.");
        return;
    }
    runDeploy();
}

function scheduleDeploy() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onQuiet, DEBOUNCE_MS);
}

function watchDist() {
    if (!fs.existsSync(distDir)) {
        setTimeout(watchDist, 500);
        return;
    }
    console.log(`[AUTODEPLOY] Watching ${distDir}`);
    fs.watch(distDir, { recursive: true }, (_event, filename) => {
        if (!filename || String(filename).endsWith(".map")) {
            return;
        }
        scheduleDeploy();
    });
}

watchDist();
