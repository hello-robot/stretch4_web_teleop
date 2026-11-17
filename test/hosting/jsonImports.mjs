/**
 * Lets the lobby's TypeScript modules be imported by a test.
 *
 * Node 24 strips TypeScript types on its own, so robotModel.ts and useRail.ts
 * load without a build step. Because robotModel.ts imports features.json
 * without an import attribute, this loader hook supplies `format: "json"` for
 * local `.json` files in the test process.
 *
 * Import this module before importing anything under src/. registerHooks is
 * synchronous and in-thread, so a static import of this file is enough to make
 * the dynamic imports that follow it work.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
    /**
     * Load a local .json file as a JSON module without requiring an attribute.
     *
     * @param {string} url URL being loaded.
     * @param {object} context Loader context.
     * @param {Function} nextLoad The loader this one wraps.
     * @returns {object} The module source and format.
     */
    load(url, context, nextLoad) {
        if (!url.startsWith("file:") || !url.endsWith(".json")) {
            return nextLoad(url, context);
        }
        return {
            format: "json",
            shortCircuit: true,
            source: readFileSync(fileURLToPath(url), "utf8"),
        };
    },
});
