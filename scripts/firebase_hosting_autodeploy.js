#!/usr/bin/env node

/**
 * firebase_hosting_autodeploy.js
 *
 * After webpack watch goes quiet for one second, upload dist-firebase/.
 * The current checkout goes to a preview channel. Onboard runtime builds
 * never update the live site; production Hosting is an explicit release.
 * Trailing edge only.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { hostingChannel } = require("./hostingChannel");
const { hostingBundleReady } = require("./hostingBundleReady");

const DEBOUNCE_MS = 1000;
const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");
const cacheFile = path.join(repoRoot, "node_modules", ".cache", "firebase-hosting-autodeploy.json");

let debounceTimer = null;
let deploying = false;
let deployAgain = false;

function computeBundleHash(dir) {
    try {
        const files = [];
        const walk = (currentDir) => {
            for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile() && !entry.name.endsWith(".map")) {
                    files.push(fullPath);
                }
            }
        };
        walk(dir);
        files.sort();
        const hash = crypto.createHash("sha256");
        for (const file of files) {
            hash.update(path.relative(dir, file));
            hash.update("\0");
            hash.update(fs.readFileSync(file));
            hash.update("\0");
        }
        return hash.digest("hex");
    } catch (err) {
        return null;
    }
}

function readLastDeployed() {
    try {
        return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch (err) {
        return null;
    }
}

function writeLastDeployed(channelId, bundleHash) {
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ channelId, bundleHash }), "utf8");
    } catch (err) {
        console.warn(`[AUTODEPLOY] Could not write deploy cache: ${err.message}`);
    }
}

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

    const bundleHash = computeBundleHash(distDir);
    const lastDeployed = readLastDeployed();
    if (bundleHash && lastDeployed && lastDeployed.channelId === channel.id && lastDeployed.bundleHash === bundleHash) {
        console.log(`[AUTODEPLOY] Preview channel ${channel.id} bundle unchanged; skipping upload.`);
        deploying = false;
        if (deployAgain) {
            deployAgain = false;
            onQuiet();
        }
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
    } else if (bundleHash) {
        writeLastDeployed(channel.id, bundleHash);
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
