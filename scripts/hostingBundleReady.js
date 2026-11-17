/**
 * A Hosting upload with no home page replaces the site with a 404.
 * Webpack empties dist-firebase/ before the new pages exist.
 */

const fs = require("fs");
const path = require("path");

const PAGES = ["index.html", "operator/index.html", "robot/index.html"];

/** The whole-site build a robot uploads to its preview channel. */
function hostingBundleReady(distDir) {
    return PAGES.every((rel) => fs.existsSync(path.join(distDir, rel)));
}

/**
 * The lobby build: the only one that emits a root index.html.
 *
 * @param {string} distDir Directory the lobby was built into.
 * @returns {boolean} True when the lobby's page is present.
 */
function lobbyBundleReady(distDir) {
    return fs.existsSync(path.join(distDir, "index.html"));
}

/**
 * One rail: its operator page and the manifest the lobby probes for.
 *
 * A rail must not carry a root index.html, or deploying it would displace the
 * lobby at /. That is a property of the build rather than of discipline, and
 * this asserts it rather than assuming it.
 *
 * @param {string} railDir Directory the rail was built into.
 * @returns {boolean} True when the rail is complete and does not shadow /.
 */
function railBundleReady(railDir) {
    return (
        fs.existsSync(path.join(railDir, "operator", "index.html")) &&
        fs.existsSync(path.join(railDir, "manifest.json")) &&
        !fs.existsSync(path.join(railDir, "index.html"))
    );
}

module.exports = { hostingBundleReady, lobbyBundleReady, railBundleReady };
