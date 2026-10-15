const PUBLIC_WEBPACK_ENV_KEYS = Object.freeze([
    "PUBLIC_FIREBASE_API_KEY",
    "PUBLIC_FIREBASE_AUTH_DOMAIN",
    "PUBLIC_FIREBASE_DATABASE_URL",
    "PUBLIC_FIREBASE_PROJECT_ID",
    "PUBLIC_FIREBASE_STORAGE_BUCKET",
    "PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "PUBLIC_FIREBASE_APP_ID",
    "PUBLIC_FIREBASE_MEASUREMENT_ID",
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
