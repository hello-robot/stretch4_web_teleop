/**
 * A Hosting upload with no home page replaces the site with a 404.
 * Webpack empties dist-firebase/ before the new pages exist.
 */

const fs = require("fs");
const path = require("path");

const PAGES = ["index.html", "operator/index.html", "robot/index.html"];

function hostingBundleReady(distDir) {
    return PAGES.every((rel) => fs.existsSync(path.join(distDir, rel)));
}

module.exports = { hostingBundleReady };
