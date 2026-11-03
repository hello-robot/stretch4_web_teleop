const PUBLIC_WEBPACK_ENV_KEYS = Object.freeze([
    "PUBLIC_FIREBASE_API_KEY",
    "PUBLIC_FIREBASE_AUTH_DOMAIN",
    "PUBLIC_FIREBASE_DATABASE_URL",
    "PUBLIC_FIREBASE_PROJECT_ID",
    "PUBLIC_FIREBASE_STORAGE_BUCKET",
    "PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "PUBLIC_FIREBASE_APP_ID",
    "PUBLIC_FIREBASE_MEASUREMENT_ID",
    "PUBLIC_HOSTING_ORIGIN",
    "PUBLIC_STABLE_RAIL",
    "HELLO_FLEET_ID",
]);

/**
 * DefinePlugin entries for the keys a browser bundle may see.
 *
 * .env wins, and the process environment answers for anything it does not
 * define, so a release job can export a value for one build without rewriting
 * the file every robot also reads.
 *
 * @param {Record<string, string>} env Parsed .env contents.
 * @returns {Record<string, string>} DefinePlugin replacements.
 */
function webpackPublicEnvDefinitions(env) {
    return Object.fromEntries(
        PUBLIC_WEBPACK_ENV_KEYS.map((key) => {
            const value = env[key] ?? process.env[key];
            return [
                `process.env.${key}`,
                value === undefined ? "undefined" : JSON.stringify(value),
            ];
        }),
    );
}

module.exports = {
    PUBLIC_WEBPACK_ENV_KEYS,
    webpackPublicEnvDefinitions,
};
