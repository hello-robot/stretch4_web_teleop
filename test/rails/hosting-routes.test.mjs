/**
 * How a published version is actually served, exercised against the Firebase
 * Hosting emulator.
 *
 * The routing and the caching of a multi-rail site live in firebase.json, not
 * in any script, so nothing in rail-backend.test.mjs can confirm them. This
 * file asks a real Hosting server the questions the lobby and an operator's
 * browser ask: is the rail there, is the lobby still at the root, and is the
 * manifest exempt from the year-long cache the rail beside it carries.
 *
 * It is started by test/rails/runHostingRoutes.mjs, which stands the emulator
 * up over a tree and exports the two variables read here. Run it through
 * `npm run test:rails:hosting`.
 */

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";

const origin = process.env.RAIL_TEST_ORIGIN;
const rail = process.env.RAIL_TEST_TAG;

/** A tag no tree under test publishes, standing in for a retired rail. */
const RETIRED_RAIL = "v0.0.1-rc9";

/**
 * Fetch a path from the emulator without letting a cache answer for it.
 *
 * @param {string} servedPath Path to request, from the site root.
 * @returns {Promise<Response>} The response.
 */
async function get(servedPath) {
    return fetch(`${origin}${servedPath}`, { cache: "no-store" });
}

before(() => {
    assert.ok(
        origin && rail,
        "run this through runHostingRoutes.mjs, which sets RAIL_TEST_ORIGIN and RAIL_TEST_TAG",
    );
});

describe("what the site serves", () => {
    test("the lobby is at the root", async () => {
        const response = await get("/");
        assert.equal(response.status, 200);
    });

    test("the unversioned operator page is beside it", async () => {
        // Every card links here while no rail resolves, so a version that
        // drops it points the whole fleet at a 404.
        const response = await get("/operator/");
        assert.equal(response.status, 200);
    });

    test("the rail serves its own operator page", async () => {
        const response = await get(`/r/${rail}/operator/`);
        assert.equal(response.status, 200);
    });

    test("the rail does not answer at its own root", async () => {
        // A rail carries no index.html of its own. If this ever answers 200,
        // the rail was built with the whole page set and is carrying a second
        // lobby.
        const response = await get(`/r/${rail}/`);
        assert.equal(response.status, 404);
    });
});

describe("what the lobby's rail probe sees", () => {
    test("a published rail answers its manifest, naming itself", async () => {
        const response = await get(`/r/${rail}/manifest.json`);
        assert.equal(response.status, 200);
        const manifest = await response.json();
        assert.equal(manifest.tag, rail);
        assert.ok(manifest.commit, "the manifest records no commit");
        assert.ok(manifest.built, "the manifest records no build time");
    });

    test("a rail that is not published answers 404, not a fault", async () => {
        // useRail.ts reads 404 and 410 as evidence of absence and anything
        // else as no answer at all. A rail withdrawn from release.json has to
        // land in the first group or a card will keep offering it.
        const response = await get(`/r/${RETIRED_RAIL}/manifest.json`);
        assert.equal(response.status, 404);
    });
});

describe("what browsers are told to keep", () => {
    test("a rail's assets are immutable for a year", async () => {
        const response = await get(`/r/${rail}/operator/`);
        assert.equal(
            response.headers.get("cache-control"),
            "public, max-age=31536000, immutable",
        );
    });

    test("the manifest is carved back out of that cache", async () => {
        // This is the one file that has to stay fresh: it is how the lobby
        // notices a rail that has been withdrawn.
        const response = await get(`/r/${rail}/manifest.json`);
        assert.equal(response.headers.get("cache-control"), "no-cache");
    });

    test("the lobby and the unversioned page are never cached", async () => {
        for (const servedPath of ["/", "/operator/"]) {
            const response = await get(servedPath);
            assert.equal(
                response.headers.get("cache-control"),
                "no-cache",
                `${servedPath} is cacheable`,
            );
        }
    });
});
