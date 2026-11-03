/**
 * Preview-channel id for the current checkout.
 *
 * Remote (clean, HEAD equals origin/<branch>): branch-<slug>
 * Otherwise: local-branch-<slug>
 *
 * Slug uses the Firebase CLI rule: / : _ # become -.
 * The live site is only branch-main.
 */

const { execFileSync } = require("child_process");

function git(repoRoot, args) {
    return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

function branchSlug(name) {
    return name.replace(/[/:_#]/g, "-");
}

/**
 * @param {string} repoRoot
 * @returns {{ id: string, live: boolean }}
 */
function hostingChannel(repoRoot) {
    const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") {
        throw new Error("detached HEAD; not deploying");
    }
    const slug = branchSlug(branch);
    const dirty = git(repoRoot, ["status", "--porcelain"]).length > 0;
    let remote = null;
    try {
        remote = git(repoRoot, ["rev-parse", `origin/${branch}`]);
    } catch {
        remote = null;
    }
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    const local = dirty || !remote || head !== remote;
    const id = `${local ? "local-branch" : "branch"}-${slug}`;
    return { id, live: id === "branch-main" };
}

module.exports = { branchSlug, hostingChannel };

if (require.main === module) {
    const channel = hostingChannel(process.cwd());
    process.stdout.write(`${channel.id}${channel.live ? " live" : ""}\n`);
}
