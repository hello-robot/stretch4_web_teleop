#!/usr/bin/env node

/**
 * Upload dist-firebase/ to this checkout's preview channel.
 * Uses the channel id only. Never publishes the live site.
 */

const path = require("path");
const { spawnSync } = require("child_process");
const { hostingChannel } = require("./hostingChannel");
const { hostingBundleReady } = require("./hostingBundleReady");

const repoRoot = path.join(__dirname, "..");
const distDir = path.join(repoRoot, "dist-firebase");
if (!hostingBundleReady(distDir)) {
    console.error("dist-firebase is missing a page. Not uploading.");
    process.exit(1);
}
const channel = hostingChannel(repoRoot);
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

console.log(`Deploying preview channel ${channel.id}...`);
const result = spawnSync(
    firebaseBin,
    ["hosting:channel:deploy", channel.id, "--expires", "30d"],
    { cwd: repoRoot, stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
