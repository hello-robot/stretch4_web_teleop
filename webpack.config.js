const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const dotenv = require("dotenv");
const { webpackPublicEnvDefinitions } = require("./scripts/webpackPublicEnv");
const { envVarName, loadFeatures, FEATURES_PATH } = require("./feature-flags");
const { isReleaseTag } = require("./scripts/releaseTag");
const { RailManifestPlugin } = require("./scripts/railManifest");

const ALL_PAGES = ["robot", "operator", "home"];

/**
 * Entries this build emits.
 *
 * The lobby and each rail are built from the same config with different
 * entries: `pages=home` emits the only root index.html there is, and
 * `pages=operator` emits none, so no rail can displace the lobby.
 *
 * @param {Record<string, unknown>} webpackEnv Values passed with --env.
 * @returns {string[]} Page names to build.
 */
function selectPages(webpackEnv) {
    const requested = webpackEnv && webpackEnv.pages;
    if (!requested) return ALL_PAGES;
    const names = String(requested)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    const unknown = names.filter((name) => !ALL_PAGES.includes(name));
    if (unknown.length > 0) {
        throw new Error(`--env pages: unknown page(s) ${unknown.join(", ")}`);
    }
    return names;
}

// Only explicitly public Firebase client configuration and the fleet identifier
// may enter browser bundles. Robot credentials and every other .env value stay local.
const env = dotenv.config().parsed || {};
const envKeys = webpackPublicEnvDefinitions(env);

module.exports = (webpackEnv, argv) => {
    const storageValue = webpackEnv && webpackEnv.storage ? webpackEnv.storage : "localstorage";
    const isProduction = argv && argv.mode === "production";
    const pages = selectPages(webpackEnv);
    const rail = webpackEnv && webpackEnv.rail ? String(webpackEnv.rail) : null;
    if (rail && !isReleaseTag(rail)) {
        throw new Error(`--env rail: ${rail} is not a release tag`);
    }
    // A rail is only ever served from Hosting, and its assets resolve under
    // /r/<tag>/. Built against the localstorage bundle they would resolve
    // under /local/ and 404.
    if (rail && storageValue !== "firebase") {
        throw new Error("--env rail requires --env storage=firebase");
    }
    envKeys["process.env.storage"] = JSON.stringify(storageValue);
    // Feature flags become boolean literals in the bundle, so `if (FEATURE_X)`
    // guards fold away when the flag is off. See features.json.
    Object.entries(loadFeatures()).forEach(([name, enabled]) => {
        envKeys[`process.env.${envVarName(name)}`] = JSON.stringify(enabled);
    });

    return {
        mode: "development",
        cache: {
            type: "filesystem",
            version: JSON.stringify({
                flags: loadFeatures(),
                storage: env.storage,
                pages,
                rail,
            }),
            buildDependencies: { config: [__filename, FEATURES_PATH] },
        },
        entry: pages.reduce((config, page) => {
            config[page] = `./src/pages/${page}/tsx/index.tsx`;
            return config;
        }, {}),
        output: {
            filename: "[name]/bundle.js",
            path: rail
                ? path.resolve(__dirname, "dist-firebase", "r", rail)
                : path.resolve(
                      __dirname,
                      storageValue === "firebase" ? "dist-firebase" : "dist",
                  ),
            // The localstorage bundle is always served under /local/, in both
            // hosting modes, so dist/ is identical whichever mode built it and
            // never has to be rebuilt because the mode changed. server.js keeps
            // a /local/ mount in both modes for exactly this reason, which also
            // lets it serve the same bundle at / when no cloud door is open.
            publicPath: rail
                ? `/r/${rail}/`
                : storageValue === "localstorage"
                  ? "/local/"
                  : "/",
            // Incremental watch builds reuse cached HTML/assets. Cleaning on
            // every rebuild can remove those cached files without re-emitting
            // them, leaving the local server with 404s.
            //
            // Only clean a directory this build owns outright: a whole-site
            // build owns dist/, and a rail owns its own r/<tag>/. A partial
            // build at the root -- the lobby, or the unversioned operator
            // page -- shares the tree with the others assembled beside it,
            // and the caller clears it once before assembling.
            clean: isProduction && (rail !== null || pages.length === ALL_PAGES.length),
        },
        optimization: {
            splitChunks: {
                chunks: "all",
            },
        },
        // node: {
        //   __dirname: false,
        // },
        plugins: [
            // Work around for Buffer is undefined:
            // https://github.com/webpack/changelog-v5/issues/10
            new webpack.ProvidePlugin({
                Buffer: ["buffer", "Buffer"],
                process: "process/browser.js",
            }),
            new webpack.DefinePlugin(envKeys),
        ].concat(
            rail ? [new RailManifestPlugin({ tag: rail, repoRoot: __dirname })] : []
        ).concat(
            pages.map(
                (page) =>
                    new HtmlWebpackPlugin({
                        inject: true,
                        template: `./src/pages/${page}/html/index.html`,
                        filename:
                            page == "home"
                                ? "index.html"
                                : `${page}/index.html`,
                        chunks: [page],
                    })
            )
        ),
        module: {
            rules: [
                {
                    test: /\.(ts)x?$/,
                    use: [
                        {
                            loader: "babel-loader",
                            options: {
                                presets: [
                                    "@babel/preset-env",
                                    [
                                        "@babel/preset-react",
                                        { runtime: "automatic" },
                                    ],
                                    "@babel/preset-typescript",
                                ],
                                plugins: ["@babel/plugin-transform-runtime"],
                            },
                        },
                    ],
                    exclude: /node_modules/,
                },
                {
                    test: /\.css$/i,
                    use: ["style-loader", "css-loader"],
                },
                {
                    test: /\.(jpe?g|png|gif|svg|mp4)$/i,
                    use: "file-loader",
                },
                {
                    test: /\.(woff2?|otf|ttf)$/i,
                    type: "asset/resource",
                },
            ],
        },
        externals: {
            express: "commonjs express",
        },
        resolve: {
            extensions: [".ts", ".tsx", ".js"],
            alias: {
                shared: path.resolve(__dirname, "./src/shared/"),
                operator: path.resolve(__dirname, "./src/pages/operator/"),
                robot: path.resolve(__dirname, "./src/pages/robot/"),
                home: path.resolve(__dirname, "./src/pages/home/"),
                "ai-gateway": path.resolve(__dirname, "./ai-gateway/"),
            },
            fallback: {
                fs: false,
                stream: false,
                zlib: false,
            },
        },
        watch: !isProduction,
        watchOptions: {
            ignored: [
                "**/node_modules/**",
                "**/.git/**",
                "**/dist/**",
                "**/dist-firebase/**",
            ],
        },
    };
};
