#!/usr/bin/env node

/**
 * stableRail.js
 *
 * The release tag the lobby treats as stable: the GitHub release marked
 * latest, which excludes drafts and pre-releases.
 *
 * A tag is not a release. Pushing v0.1.1 publishes nothing, so a tag that has
 * never been released cannot become the fleet's default — publishing is the
 * deliberate step that makes a rail eligible.
 *
 * Prints the tag and exits 0, or prints nothing and exits 0 when the
 * repository has no published release yet:
 *
 *     PUBLIC_STABLE_RAIL=$(node scripts/stableRail.js)
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { isReleaseTag } = require("./releaseTag");

const GITHUB_API = "https://api.github.com";

/**
 * owner/name of the GitHub repository origin points at.
 *
 * @param {string} repoRoot Directory to read the remote from.
 * @returns {string} The owner/name slug.
 * @throws {Error} When origin is missing or is not a GitHub remote.
 */
function repoSlug(repoRoot) {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
    if (!match) {
        throw new Error(`origin is not a GitHub remote: ${url}`);
    }
    return `${match[1]}/${match[2]}`;
}

/**
 * Resolve the stable release tag from GitHub.
 *
 * Reads GITHUB_TOKEN when it is set, which a private fork needs and a public
 * repository does not.
 *
 * @param {string} repoRoot Directory whose origin names the repository.
 * @returns {Promise<string|null>} The tag, or null when nothing is published.
 * @throws {Error} When GitHub answers with anything but 200 or 404, or when
 *     the released tag does not match the rail grammar.
 */
async function stableRail(repoRoot) {
    const slug = repoSlug(repoRoot);
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "stretch4-web-teleop",
    };
    if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(
        `${GITHUB_API}/repos/${slug}/releases/latest`,
        { headers },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(
            `GitHub returned ${response.status} for ${slug} releases/latest`,
        );
    }

    const tag = (await response.json()).tag_name;
    if (!isReleaseTag(tag)) {
        throw new Error(
            `latest release is tagged ${tag}, which is not a rail name`,
        );
    }
    return tag;
}

module.exports = { repoSlug, stableRail };

if (require.main === module) {
    stableRail(path.join(__dirname, "..")).then(
        (tag) => {
            if (tag) process.stdout.write(`${tag}\n`);
        },
        (error) => {
            console.error(error.message);
            process.exit(1);
        },
    );
}
