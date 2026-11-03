#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const requiredFiles = process.argv.slice(2);
const timeoutMs = Number(process.env.WEB_TELEOP_BUILD_TIMEOUT_MS || 120000);
const startedAt = Date.now();

if (requiredFiles.length === 0) {
    console.error("Usage: waitForBundles.js <relative-file> [...]");
    process.exit(1);
}

function missingFiles() {
    return requiredFiles.filter(
        (relativePath) => !fs.existsSync(path.join(repoRoot, relativePath)),
    );
}

function wait() {
    const missing = missingFiles();
    if (missing.length === 0) {
        console.log(`[BUNDLES] Ready: ${requiredFiles.join(", ")}`);
        return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
        console.error(`[BUNDLES] Timed out waiting for: ${missing.join(", ")}`);
        process.exit(1);
    }
    setTimeout(wait, 250);
}

wait();
