/**
 * Emits the lobby.json that a lobby describes itself with.
 *
 * A release that leaves the live lobby in place reads this file to report
 * which release that lobby was built from, and to refuse retiring the rail it
 * routes to by default.
 */

const { isReleaseTag } = require("./releaseTag");
const { checkoutIdentity, emitJsonAsset } = require("./railManifest");

const PLUGIN = "LobbyManifestPlugin";

/** Path the manifest is served at, relative to the site root. */
const LOBBY_MANIFEST = "lobby.json";

/**
 * The metadata a lobby is identified by.
 *
 * @param {{repoRoot: string, stable?: string|null}} options The checkout the
 *     lobby is built from, and the PUBLIC_STABLE_RAIL value baked into it.
 * @returns {{tag: string|null, commit: string|null, describe: string|null,
 *     stable: string|null, built: string}} The manifest contents. tag is the
 *     describe when it is exactly a release tag; stable is null unless it is
 *     a release tag, matching what the lobby itself accepts.
 */
function lobbyManifest({ repoRoot, stable }) {
    const { commit, describe } = checkoutIdentity(repoRoot);
    return {
        tag: isReleaseTag(describe) ? describe : null,
        commit,
        describe,
        stable: isReleaseTag(stable) ? stable : null,
        built: new Date().toISOString(),
    };
}

class LobbyManifestPlugin {
    /**
     * @param {{repoRoot: string, stable?: string|null}} options The checkout
     *     the lobby is built from, and the stable rail baked into it.
     */
    constructor({ repoRoot, stable }) {
        this.repoRoot = repoRoot;
        this.stable = stable ?? null;
    }

    /**
     * Emit lobby.json beside the lobby's index.html.
     *
     * @param {import("webpack").Compiler} compiler Webpack compiler.
     * @returns {void}
     */
    apply(compiler) {
        emitJsonAsset(compiler, PLUGIN, LOBBY_MANIFEST, () =>
            lobbyManifest({ repoRoot: this.repoRoot, stable: this.stable })
        );
    }
}

module.exports = { LOBBY_MANIFEST, LobbyManifestPlugin, lobbyManifest };
