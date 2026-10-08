const PUBLIC_WEBPACK_ENV_KEYS = Object.freeze([
    "apiKey",
    "authDomain",
    "databaseURL",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
    "measurementId",
    "HELLO_FLEET_ID",
]);

function webpackPublicEnvDefinitions(env) {
    return Object.fromEntries(
        PUBLIC_WEBPACK_ENV_KEYS.map((key) => [
            `process.env.${key}`,
            env[key] === undefined ? "undefined" : JSON.stringify(env[key]),
        ]),
    );
}

module.exports = {
    PUBLIC_WEBPACK_ENV_KEYS,
    webpackPublicEnvDefinitions,
};
