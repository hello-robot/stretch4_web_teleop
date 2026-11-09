/**
 * Emits the manifest.json that a rail describes itself with.
 *
 * The lobby confirms a rail exists by fetching this file: 200 routes there,
 * 404 refuses. It ships inside the rail and is immutable with it, so there is
 * no central index of deployed versions to drift out of step.
 */

const { execFileSync } = require("child_process");

const PLUGIN = "RailManifestPlugin";

/**
 * Read a git value, or null when git cannot answer.
 *
 * @param {string} repoRoot Directory to run git in.
 * @param {string[]} args Arguments to git.
 * @returns {string|null} Trimmed stdout, or null.
 */
function git(repoRoot, args) {
    try {
        return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * The metadata a rail is probed by.
 *
 * A rail is built only from a clean release checkout, so describe equals tag.
 * It is recorded anyway: it is what git itself says the bytes came from, and a
 * manifest whose describe disagrees with its tag is evidence the rail was not
 * built the way the release claims.
 *
 * commit is the field deployHosting compares a republish against, so a
 * checkout git cannot read leaves it null rather than guessing -- a null
 * commit refuses a live republish instead of waving one through.
 *
 * @param {{tag: string, repoRoot: string}} options Rail tag, and the checkout
 *     whose commit the manifest records.
 * @returns {{tag: string, commit: string|null, describe: string|null,
 *     built: string}} The manifest contents.
 */
function railManifest({ tag, repoRoot }) {
    return {
        tag,
        commit: git(repoRoot, ["rev-parse", "HEAD"]),
        describe: git(repoRoot, [
            "describe",
            "--tags",
            "--always",
            "--dirty",
            "--match",
            "v*",
        ]),
        built: new Date().toISOString(),
    };
}

class RailManifestPlugin {
    /**
     * @param {{tag: string, repoRoot: string}} options Rail tag, and the
     *     checkout whose commit the manifest records.
     */
    constructor({ tag, repoRoot }) {
        this.tag = tag;
        this.repoRoot = repoRoot;
    }

    /**
     * @param {import("webpack").Compiler} compiler Webpack compiler.
     * @returns {void}
     */
    apply(compiler) {
        const { RawSource } = compiler.webpack.sources;
        compiler.hooks.thisCompilation.tap(PLUGIN, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: PLUGIN,
                    stage: compiler.webpack.Compilation
                        .PROCESS_ASSETS_STAGE_ADDITIONAL,
                },
                () => {
                    const manifest = railManifest({
                        tag: this.tag,
                        repoRoot: this.repoRoot,
                    });
                    compilation.emitAsset(
                        "manifest.json",
                        new RawSource(`${JSON.stringify(manifest, null, 2)}\n`),
                    );
                },
            );
        });
    }
}

module.exports = { RailManifestPlugin, railManifest };
