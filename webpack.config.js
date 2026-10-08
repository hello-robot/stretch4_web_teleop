const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const dotenv = require("dotenv");
const { envVarName, loadFeatures } = require("./feature-flags");
const {
    webpackPublicEnvDefinitions,
} = require("./scripts/webpackPublicEnv");

const pages = ["robot", "operator", "home"];

// Only explicitly public Firebase client configuration and the fleet identifier
// may enter browser bundles. Robot credentials and every other .env value stay local.
const env = dotenv.config().parsed || {};
const envKeys = webpackPublicEnvDefinitions(env);

module.exports = (webpackEnv, argv) => {
    const storageValue = webpackEnv && webpackEnv.storage ? webpackEnv.storage : "localstorage";
    const dualMode = webpackEnv?.dual === true || webpackEnv?.dual === "true";
    const isProduction = argv && argv.mode === "production";
    envKeys["process.env.storage"] = JSON.stringify(storageValue);
    envKeys["process.env.dual_signaling"] = JSON.stringify(
        storageValue === "firebase" && dualMode,
    );
    // Feature flags become boolean literals in the bundle, so `if (FEATURE_X)`
    // guards fold away when the flag is off. See features.json.
    Object.entries(loadFeatures()).forEach(([name, enabled]) => {
        envKeys[`process.env.${envVarName(name)}`] = JSON.stringify(enabled);
    });

    return {
        mode: argv && argv.mode ? argv.mode : "development",
        entry: pages.reduce((config, page) => {
            config[page] = `./src/pages/${page}/tsx/index.tsx`;
            return config;
        }, {}),
        output: {
            filename: "[name]/bundle.js",
            path: path.resolve(
                __dirname,
                storageValue === "firebase" ? "dist-firebase" : "dist",
            ),
            publicPath:
                storageValue === "localstorage" && dualMode
                    ? "/local/"
                    : "/",
            // Incremental watch builds reuse cached HTML/assets. Cleaning on
            // every rebuild can remove those cached files without re-emitting
            // them, leaving the local server with 404s.
            clean: isProduction,
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
    };
};
