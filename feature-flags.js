/**
 * Single source of truth for feature flags.
 *
 * Defaults live in features.json, and may be overwritten by env variables
 *
 * Consumers:
 *   - server.js               requires a feature's modules only when it is enabled
 *   - webpack.config.js       defines process.env.FEATURE_<NAME> in the bundle
 *   - launch scripts          via the CLI below, which prints "1" or "0":
 *                                 node feature-flags.js <name>
 *                             or lists every flag as NAME=1/0:
 *                                 node feature-flags.js --all
 */

const fs = require("fs");
const path = require("path");

const FEATURES_PATH = path.join(__dirname, "features.json");

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Environment variable that overrides a flag.
 *
 * @param {string} name flag name as declared in features.json
 * @returns {string} the name uppercased and prefixed, e.g. "foo" -> "FEATURE_FOO"
 */
function envVarName(name) {
    return `FEATURE_${name.toUpperCase()}`;
}

/**
 * @param {string} name flag name, for the error message
 * @param {string} raw environment variable value
 * @returns {boolean}
 */
function parseOverride(name, raw) {
    const value = String(raw).trim().toLowerCase();
    if (TRUTHY.has(value)) return true;
    if (FALSY.has(value)) return false;
    throw new Error(
        `${envVarName(name)}="${raw}" is not a boolean; use 1/0, true/false, yes/no or on/off.`
    );
}

/**
 * Every declared flag with environment overrides applied. Read fresh on each
 * call so a long-lived process sees an edited features.json on restart only,
 * not a stale require cache.
 *
 * @returns {Record<string, boolean>} flag name -> enabled
 */
function loadFeatures() {
    const registry = JSON.parse(fs.readFileSync(FEATURES_PATH, "utf8"));
    const features = {};
    for (const [name, entry] of Object.entries(registry)) {
        const override = process.env[envVarName(name)];
        features[name] =
            override === undefined || override === ""
                ? Boolean(entry.enabled)
                : parseOverride(name, override);
    }
    return features;
}

/**
 * @param {string} name flag name; must be declared in features.json
 * @returns {boolean}
 */
function isEnabled(name) {
    const features = loadFeatures();
    if (!(name in features)) {
        throw new Error(
            `Unknown feature "${name}"; declare it in features.json.`
        );
    }
    return features[name];
}

module.exports = { envVarName, isEnabled, loadFeatures };

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === "--all") {
        // Usage: node feature-flags.js --all
        // Prints every declared flag as NAME=1/0, one per line -- for launch-script logging.
        const features = loadFeatures();
        for (const [name, enabled] of Object.entries(features)) {
            process.stdout.write(`${envVarName(name)}=${enabled ? "1" : "0"}\n`);
        }
        process.exit(0);
    }
    if (!arg) {
        process.stderr.write("Usage: node feature-flags.js <feature-name>|--all\n");
        process.exit(2);
    }
    try {
        process.stdout.write(isEnabled(arg) ? "1" : "0");
    } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
    }
}
