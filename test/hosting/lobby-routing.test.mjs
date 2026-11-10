/**
 * The lobby's half of the rail decision, exercised offline.
 *
 * A robot reports what it is running; the lobby decides where that sends an
 * operator. That decision is made by the pure functions in robotModel.ts and
 * by the manifest probe in useRail.ts, and it is the part a practitioner
 * cannot check by reading a deploy log: it happens in the browser, after the
 * release is already published.
 *
 * hosting-backend.test.mjs checks that robotModel.ts spells the tag grammar the
 * same way the rest of the system does. This file runs the functions.
 *
 * What it deliberately does not cover: useRailAvailable, the React hook that
 * wraps probeRail. Rendering a hook needs a DOM and a renderer, neither of
 * which this repository carries, and the decision inside the hook is
 * probeRail's. The hook's own job -- answering true for a null rail, true
 * again for an already-confirmed one, and null while a probe is outstanding --
 * is checked by eye on a card.
 *
 * Run through `npm run test:hosting:lobby`.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, suite, test } from "node:test";

import "./jsonImports.mjs";

const {
    branchLabel,
    buildLabel,
    buildTitle,
    buildWarning,
    isUnreleasedBuild,
    operatorHref,
    railFor,
    railGate,
    railNotice,
    releaseBehind,
    routedRail,
    servesRails,
} = await import("../../src/pages/home/tsx/robotModel.ts");
const { probeRail } = await import("../../src/pages/home/tsx/useRail.ts");

/** The origin a release of the lobby is built against. */
const LIVE = "https://stretch4-web-interface.web.app";

/** A preview channel's origin: its own site, so it serves no rails. */
const PREVIEW = "https://stretch4-web-interface--rails-x-a1b2c3.web.app";

/** The release a lobby under test treats as stable, unless a case says otherwise. */
const STABLE = "v0.2.0";

let realFetch;
let savedEnv;

/**
 * Describe the deployment the lobby is running in.
 *
 * In a bundle these two are DefinePlugin literals rather than reads of a live
 * environment, so a card cannot change deployment while a dashboard is open.
 * They are set here the way the build sets them: once, before the functions
 * that read them are called.
 *
 * @param {string} origin Origin the lobby is served from.
 * @param {string|null} [stable] Stable release baked in beside it, or null.
 * @returns {void}
 */
function servedFrom(origin, stable = STABLE) {
    globalThis.location = { origin };
    process.env.PUBLIC_HOSTING_ORIGIN = LIVE;
    if (stable === null) delete process.env.PUBLIC_STABLE_RAIL;
    else process.env.PUBLIC_STABLE_RAIL = stable;
}

/**
 * A robot record as the dashboard reads one out of the database.
 *
 * @param {object} [fields] Fields to set: describe, rail and branch.
 * @returns {object} The record.
 */
function robot({ describe, rail, branch } = {}) {
    const record = { name: "stretch-se4-4017", status: "online" };
    if (branch !== undefined) record.branch = branch;
    if (describe !== undefined || rail !== undefined) {
        record.build = {};
        if (describe !== undefined) record.build.describe = describe;
        if (rail !== undefined) record.build.rail = rail;
    }
    return record;
}

/**
 * Describes of checkouts with changes on top of a release, each with the
 * release behind it: uncommitted changes, commits after the tag, and both.
 */
const PAST_A_RELEASE = [
    ["v0.1.0-dirty", "v0.1.0"],
    ["v0.1.0-7-gabc1234", "v0.1.0"],
    ["v0.1.0-7-gabc1234-dirty", "v0.1.0"],
    ["v0.3.0-alpha2-1-g0123abc", "v0.3.0-alpha2"],
    ["v1.0.0-rc10-12-gdeadbeef12-dirty", "v1.0.0-rc10"],
];

/**
 * Describes that name no release tag to route to. The tag parsed out of a
 * describe becomes a URL path segment, so the list leans on shapes that are
 * nearly right.
 */
const NO_RELEASE_BEHIND = [
    "abc1234",
    "abc1234-dirty",
    "v1.2-3-gabc1234",
    "v0.1.0-dev1-2-gabc1234",
    "v0.1.0-7",
    "v0.1.0-7-gxyz",
    "v0.1.0-dirty-dirty",
    "v0.1.0-7-gabc1234/../../etc",
    "../v0.1.0-7-gabc1234",
    "x",
];

/** Rail names are handed out one per case, since a probe caches by name. */
let railCounter = 0;

/**
 * A rail name no other case in this file has probed.
 *
 * probeRail caches a confirmed rail for the life of the process, which is the
 * behaviour a dashboard wants and a shared fixture would hide.
 *
 * @returns {string} An unused release tag.
 */
function freshRail() {
    railCounter += 1;
    return `v9.${railCounter}.0`;
}

/**
 * Stand in for the origin answering a manifest probe.
 *
 * @param {Array<{status?: number, throws?: boolean}>} answers One entry per
 *     expected request; the last is repeated once it runs out.
 * @returns {{fetch: Function, calls: () => number}} The replacement and a
 *     count of the requests it received.
 */
function answering(answers) {
    let calls = 0;
    return {
        fetch: async () => {
            const answer = answers[Math.min(calls, answers.length - 1)];
            calls += 1;
            if (answer.throws) throw new Error("network unreachable");
            const status = answer.status ?? 200;
            return { ok: status >= 200 && status < 300, status };
        },
        calls: () => calls,
    };
}

before(() => {
    realFetch = globalThis.fetch;
    savedEnv = {
        origin: process.env.PUBLIC_HOSTING_ORIGIN,
        stable: process.env.PUBLIC_STABLE_RAIL,
    };
});

beforeEach(() => servedFrom(LIVE));

afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.location;
    for (const [key, value] of [
        ["PUBLIC_HOSTING_ORIGIN", savedEnv.origin],
        ["PUBLIC_STABLE_RAIL", savedEnv.stable],
    ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

suite("only the live Hosting origin serves rails", () => {
    test("returns true when served from the configured live Hosting origin", () => {
        servedFrom(LIVE);
        assert.equal(servesRails(), true);
    });

    test("returns false on a preview channel origin", () => {
        // A preview is a whole-site build on its own origin. It publishes one
        // interface at /operator/ and no r/ tree, so a card that routed to a
        // rail there would route to a 404.
        servedFrom(PREVIEW);
        assert.equal(servesRails(), false);
    });

    test("returns false when served locally by the robot's onboard web server", () => {
        // In firebase mode server.js mounts dist-firebase at / on the robot,
        // so this same lobby answers at the robot's address.
        servedFrom("http://stretch-se4-4017.local:8000");
        assert.equal(servesRails(), false);
    });

    test("returns true when the configured origin ends in a slash or carries a path", () => {
        // location.origin never ends in a slash, so a configured value that
        // does must still name the same origin.
        for (const configured of [`${LIVE}/`, `${LIVE}/index.html`]) {
            servedFrom(LIVE);
            process.env.PUBLIC_HOSTING_ORIGIN = configured;
            assert.equal(servesRails(), true, `${configured} serves no rails`);
        }

        // Control: the slash is ignored, not the origin before it.
        servedFrom(LIVE);
        process.env.PUBLIC_HOSTING_ORIGIN = `${PREVIEW}/`;
        assert.equal(servesRails(), false);
    });

    test("returns false when the configured origin is not a URL", () => {
        servedFrom(LIVE);
        process.env.PUBLIC_HOSTING_ORIGIN = "stretch4-web-interface.web.app";
        assert.equal(servesRails(), false);

        // Control: the same host with its scheme is the live origin.
        process.env.PUBLIC_HOSTING_ORIGIN = LIVE;
        assert.equal(servesRails(), true);
    });

    test("returns false when PUBLIC_HOSTING_ORIGIN is unset", () => {
        // PUBLIC_HOSTING_ORIGIN unset becomes the literal undefined in the
        // bundle. location.origin is always a string, so the comparison fails
        // and every card keeps the unversioned page.
        globalThis.location = { origin: LIVE };
        delete process.env.PUBLIC_HOSTING_ORIGIN;
        assert.equal(servesRails(), false);
    });
});

suite("a robot card routes to its release rail or falls back to the stable rail", () => {
    test("routes a robot on a release tag to that release's rail", () => {
        assert.equal(railFor(robot({ describe: "v0.1.0", rail: "v0.1.0" })), "v0.1.0");
    });

    test("routes to the robot's reported rail even if retired from release.json", () => {
        // Nothing here knows which rails are published; that is what the
        // manifest probe is for. Deciding it from release.json would need the
        // lobby to be rebuilt every time a rail is retired.
        assert.equal(railFor(robot({ describe: "v0.0.1", rail: "v0.0.1" })), "v0.0.1");
    });

    test("routes a checkout with changes on top of a release to that release's rail", () => {
        for (const [describe, rail] of PAST_A_RELEASE) {
            assert.equal(railFor(robot({ describe })), rail, describe);
        }
    });

    test("falls back to the stable release when the describe has no release tag behind it", () => {
        for (const describe of NO_RELEASE_BEHIND) {
            assert.equal(railFor(robot({ describe })), STABLE, describe);
        }
    });

    test("releaseBehind names the tag only for a checkout that has moved past it", () => {
        for (const [describe, rail] of PAST_A_RELEASE) {
            assert.equal(releaseBehind(robot({ describe })), rail, describe);
        }
        for (const describe of NO_RELEASE_BEHIND) {
            assert.equal(releaseBehind(robot({ describe })), null, describe);
        }
        // A robot exactly on a tag reports that tag as its rail, and a robot
        // that reports no build has no describe to read.
        assert.equal(
            releaseBehind(robot({ describe: "v0.1.0", rail: "v0.1.0" })),
            null
        );
        assert.equal(releaseBehind(robot({ branch: "main" })), null);
    });

    test("falls back to the stable release when a robot reports no build", () => {
        assert.equal(railFor(robot({ branch: "main" })), STABLE);
    });

    test("ignores a reported rail outside the release tag grammar and uses the stable release", () => {
        // The database refuses these on write, so one can only arrive from a
        // record written before that rule existed. It becomes a URL path
        // segment, so it is refused again here.
        for (const rail of ["../../etc", "main", "v1.2", "v1.2.3-dirty"]) {
            assert.equal(railFor(robot({ describe: "x", rail })), STABLE);
        }
    });

    test("returns null for the unversioned page when no stable release is set", () => {
        servedFrom(LIVE, null);
        assert.equal(railFor(robot({ branch: "main" })), null);
        assert.equal(railFor(robot({ describe: "abc1234" })), null);
        // A release behind the checkout is still named by the describe.
        assert.equal(
            railFor(robot({ describe: "v0.1.0-7-gabc1234" })),
            "v0.1.0"
        );
    });

    test("ignores PUBLIC_STABLE_RAIL when it does not match the release tag grammar", () => {
        servedFrom(LIVE, "latest");
        assert.equal(railFor(robot({ branch: "main" })), null);
    });

    test("returns null for all robots when the origin does not serve rails", () => {
        servedFrom(PREVIEW);
        assert.equal(railFor(robot({ describe: "v0.1.0", rail: "v0.1.0" })), null);
        assert.equal(railFor(robot({ describe: "v0.1.0-7-gabc1234" })), null);
        assert.equal(railFor(robot({ branch: "main" })), null);
    });
});

suite("a robot whose release is not deployed opens the stable release", () => {
    test("opens the stable rail when the robot's own rail is absent", () => {
        const record = robot({ describe: "v0.3.0-alpha1", rail: "v0.3.0-alpha1" });
        const wanted = railFor(record);
        assert.equal(routedRail(wanted, false), STABLE);
        assert.equal(
            operatorHref(routedRail(wanted, false), "stretch-se4-4017"),
            `/r/${STABLE}/operator/?robot=stretch-se4-4017`
        );

        // Control: the same robot with its rail deployed keeps it.
        assert.equal(routedRail(wanted, true), "v0.3.0-alpha1");
        assert.equal(
            operatorHref(routedRail(wanted, true), "stretch-se4-4017"),
            "/r/v0.3.0-alpha1/operator/?robot=stretch-se4-4017"
        );
    });

    test("opens the stable rail when the release behind a checkout is absent", () => {
        const wanted = railFor(robot({ describe: "v0.1.0-7-gabc1234-dirty" }));
        assert.equal(routedRail(wanted, false), STABLE);
        assert.equal(routedRail(wanted, true), "v0.1.0");
    });

    test("keeps the robot's own rail while the probe is outstanding", () => {
        assert.equal(routedRail("v0.3.0-alpha1", null), "v0.3.0-alpha1");
    });

    test("opens the unversioned page when the rail is absent and no stable release is set", () => {
        servedFrom(LIVE, null);
        assert.equal(routedRail("v0.3.0-alpha1", false), null);
        assert.equal(routedRail("v0.3.0-alpha1", true), "v0.3.0-alpha1");
    });

    test("leaves a card on the unversioned page there", () => {
        assert.equal(routedRail(null, true), null);
        assert.equal(routedRail(null, false), null);
    });
});

suite("an operator link targets /r/<rail>/operator/ when a rail resolves and /operator/ otherwise", () => {
    test("builds a versioned /r/<rail>/operator/ URL when a rail resolves", () => {
        assert.equal(
            operatorHref("v0.1.0", "stretch-se4-4017"),
            "/r/v0.1.0/operator/?robot=stretch-se4-4017",
        );
    });

    test("builds the URL of the release behind a checkout that has moved past it", () => {
        assert.equal(
            operatorHref(
                railFor(robot({ describe: "v0.1.0-7-gabc1234-dirty" })),
                "stretch-se4-4017"
            ),
            "/r/v0.1.0/operator/?robot=stretch-se4-4017"
        );
    });

    test("builds an unversioned /operator/ URL when no rail resolves", () => {
        servedFrom(LIVE, null);
        assert.equal(
            operatorHref(railFor(robot({ branch: "main" })), "stretch-se4-4017"),
            "/operator/?robot=stretch-se4-4017",
        );
    });

    test("URL-encodes the robot query parameter on both versioned and unversioned paths", () => {
        assert.equal(
            operatorHref("v0.1.0", "a robot&x=1"),
            "/r/v0.1.0/operator/?robot=a%20robot%26x%3D1",
        );
        assert.equal(
            operatorHref(null, "a robot&x=1"),
            "/operator/?robot=a%20robot%26x%3D1",
        );
    });

    test("links to /operator/ on a preview channel even when the robot reports a release rail", () => {
        servedFrom(PREVIEW);
        assert.equal(
            operatorHref(
                railFor(robot({ describe: "v0.1.0", rail: "v0.1.0" })),
                "stretch-se4-4017"
            ),
            "/operator/?robot=stretch-se4-4017",
        );
    });
});

suite("a card badge shows build.describe on the live site and branch on a preview channel", () => {
    test("branchLabel returns unknown for undefined, empty string, or detached HEAD", () => {
        assert.equal(branchLabel(undefined), "unknown");
        assert.equal(branchLabel(""), "unknown");
        assert.equal(branchLabel("HEAD"), "unknown");
        assert.equal(branchLabel("feature/rails"), "feature/rails");
    });

    test("buildLabel prefers build.describe over branch when the lobby serves rails", () => {
        const record = robot({ describe: "v0.1.0", rail: "v0.1.0", branch: "main" });
        assert.equal(buildLabel(record), "v0.1.0");
    });

    test("buildLabel prefers branch over build.describe on a preview channel", () => {
        servedFrom(PREVIEW);
        const record = robot({ describe: "v0.1.0-7-gabc1234", branch: "feature/rails" });
        assert.equal(buildLabel(record), "feature/rails");
    });

    test("buildLabel falls back to build.describe on a preview channel when HEAD is detached", () => {
        servedFrom(PREVIEW);
        const record = robot({ describe: "v0.1.0-7-gabc1234", branch: "HEAD" });
        assert.equal(buildLabel(record), "v0.1.0-7-gabc1234");
    });

    test("buildLabel returns unknown when the robot reports neither build nor branch", () => {
        assert.equal(buildLabel(robot()), "unknown");
    });
});

suite("a card tooltip states which interface the card will open", () => {
    test("states the matching release version when the robot is on a release rail", () => {
        const record = robot({ describe: "v0.1.0", rail: "v0.1.0" });
        assert.equal(
            buildTitle(record, railFor(record)),
            "Release v0.1.0 — this card opens that version of the interface",
        );
    });

    test("names the release a checkout has changes outside of", () => {
        const record = robot({ describe: "v0.1.0-7-gabc1234-dirty" });
        assert.equal(
            buildTitle(record, railFor(record)),
            "v0.1.0-7-gabc1234-dirty has changes outside of v0.1.0 — this card opens the v0.1.0 interface"
        );
    });

    test("explains that a checkout with no release behind it opens the stable release", () => {
        const record = robot({ describe: "abc1234-dirty" });
        assert.match(
            buildTitle(record, railFor(record)),
            /abc1234-dirty is not a release .* the stable release, v0\.2\.0/
        );
    });

    test("explains that a robot reporting no build opens the stable release", () => {
        const record = robot({ branch: "main" });
        assert.match(
            buildTitle(record, railFor(record)),
            /reports no build .* the stable release, v0\.2\.0/,
        );
    });

    test("explains that the card opens the default interface when no stable release is set", () => {
        servedFrom(LIVE, null);
        const record = robot({ branch: "main" });
        assert.match(
            buildTitle(record, railFor(record)),
            /no stable release is set, so this card opens the default interface/,
        );
    });

    test("names the stable release a card opens when the robot's release is not deployed", () => {
        const record = robot({ describe: "v0.3.0-alpha1", rail: "v0.3.0-alpha1" });
        const wanted = railFor(record);
        assert.equal(
            buildTitle(record, wanted, routedRail(wanted, false)),
            "Release v0.3.0-alpha1 is not deployed — this card opens the stable release, v0.2.0"
        );

        // Control: with the rail deployed, the title names the robot's own.
        assert.equal(
            buildTitle(record, wanted, routedRail(wanted, true)),
            "Release v0.3.0-alpha1 — this card opens that version of the interface"
        );
    });

    test("names the default interface when the release is not deployed and no stable release is set", () => {
        servedFrom(LIVE, null);
        const record = robot({ describe: "v0.3.0-alpha1", rail: "v0.3.0-alpha1" });
        const wanted = railFor(record);
        assert.equal(
            buildTitle(record, wanted, routedRail(wanted, false)),
            "Release v0.3.0-alpha1 is not deployed and no stable release is set — this card opens the default interface"
        );
    });

    test("states that a preview channel serves a single interface", () => {
        servedFrom(PREVIEW);
        const record = robot({ describe: "v0.1.0", rail: "v0.1.0", branch: "main" });
        assert.match(
            buildTitle(record, railFor(record)),
            /this channel serves one interface, and this card opens it/,
        );
    });
});

suite("an unreleased build warns the operator only when the lobby routes by rail", () => {
    test("isUnreleasedBuild is true only when build is present without a valid release rail", () => {
        assert.equal(isUnreleasedBuild(robot({ describe: "v0.1.0-7-gabc1234" })), true);
        assert.equal(isUnreleasedBuild(robot({ describe: "v0.1.0", rail: "v0.1.0" })), false);
    });

    test("isUnreleasedBuild is false when the robot has never reported a build object", () => {
        assert.equal(isUnreleasedBuild(robot()), false);
        assert.equal(isUnreleasedBuild(robot({ branch: "main" })), false);
    });

    test("buildWarning names the release a checkout has changes outside of", () => {
        for (const [describe, rail] of PAST_A_RELEASE) {
            const record = robot({ describe });
            const warning = buildWarning(record, railFor(record));
            assert.equal(
                warning,
                `Unreleased changes on ${rail}\n→ Routes to ${rail}`,
                `${describe}: ${warning}`
            );
            assert.doesNotMatch(warning, /Defaults to stable/);
        }
    });

    test("buildWarning names the stable release when no release is behind the checkout", () => {
        const record = robot({ describe: "abc1234-dirty" });
        const warning = buildWarning(record, railFor(record));
        assert.equal(
            warning,
            "Checkout is not a release\n→ Defaults to stable (v0.2.0)"
        );
        assert.doesNotMatch(warning, /Unreleased changes/);
    });

    test("buildWarning names the default interface when no stable release is set", () => {
        servedFrom(LIVE, null);
        const record = robot({ describe: "abc1234" });
        assert.equal(
            buildWarning(record, railFor(record)),
            "Checkout is not a release\n→ Defaults to default interface",
        );
    });

    test("buildWarning returns null when the robot is on a release tag", () => {
        const record = robot({ describe: "v0.1.0", rail: "v0.1.0" });
        assert.equal(buildWarning(record, railFor(record)), null);
    });

    test("buildWarning names an undeployed release and the stable interface opened in its place", () => {
        const record = robot({ describe: "v0.3.0-alpha1", rail: "v0.3.0-alpha1" });
        const wanted = railFor(record);
        assert.equal(
            buildWarning(record, wanted, routedRail(wanted, false)),
            "Release v0.3.0-alpha1 not deployed\n→ Defaults to stable (v0.2.0)"
        );

        // Control: the same robot with its rail deployed has nothing to warn about.
        assert.equal(buildWarning(record, wanted, routedRail(wanted, true)), null);
    });

    test("buildWarning says the release behind a checkout is not deployed", () => {
        for (const [describe, behind] of PAST_A_RELEASE) {
            const record = robot({ describe });
            const wanted = railFor(record);
            assert.equal(
                buildWarning(record, wanted, routedRail(wanted, false)),
                `Release ${behind} not deployed\n→ Defaults to stable (v0.2.0)`,
                describe
            );

            // Control: with that rail deployed, the warning does not claim otherwise.
            assert.doesNotMatch(
                buildWarning(record, wanted, routedRail(wanted, true)),
                /not deployed|Defaults to stable/,
                describe
            );
        }
    });

    test("buildWarning names the default interface when the release is not deployed and no stable release is set", () => {
        servedFrom(LIVE, null);
        const record = robot({ describe: "v0.3.0-alpha1", rail: "v0.3.0-alpha1" });
        const wanted = railFor(record);
        assert.equal(
            buildWarning(record, wanted, routedRail(wanted, false)),
            "Release v0.3.0-alpha1 not deployed\n→ Defaults to default interface"
        );
    });

    test("buildWarning returns null when the robot reports no build", () => {
        assert.equal(buildWarning(robot({ branch: "main" }), STABLE), null);
    });

    test("buildWarning returns null on a preview channel for any checkout", () => {
        servedFrom(PREVIEW);
        const record = robot({ describe: "v0.1.0-7-gabc1234", branch: "feature/rails" });
        assert.equal(buildWarning(record, railFor(record)), null);
    });
});

suite("a card says a rail is not deployed only once the origin has said so", () => {
    test("names the release when the probe found the rail absent", () => {
        assert.equal(
            railNotice("v0.2.0-alpha2", false),
            "Release v0.2.0-alpha2 is not deployed"
        );
    });

    test("stays silent while the probe is outstanding and once the rail is confirmed", () => {
        assert.equal(railNotice("v0.2.0-alpha2", null), null);
        assert.equal(railNotice("v0.2.0-alpha2", true), null);
    });

    test("stays silent for a card that routes to the unversioned page", () => {
        assert.equal(railNotice(null, false), null);
        assert.equal(railNotice(null, true), null);
    });

    test("names the stable release when the rail a card fell back to is absent too", () => {
        const wanted = railFor(robot({ describe: "v0.1.0-7-gabc1234-dirty" }));
        assert.equal(
            railNotice(routedRail(wanted, false), false),
            `Release ${STABLE} is not deployed`
        );

        // Control: a fallback that is deployed gives the card nothing to say.
        assert.equal(railNotice(routedRail(wanted, false), true), null);
    });
});

suite("a refusal replaces the controls that start or open the interface", () => {
    const REFUSAL = "Release v0.2.0-alpha2 is not deployed";

    test("replaces a start control and an enter control with the refusal", () => {
        assert.equal(railGate("start", false, REFUSAL), "refused");
        assert.equal(railGate("enter", false, REFUSAL), "refused");

        // Control: the same controls with nothing to refuse are shown.
        assert.equal(railGate("start", true, null), "open");
        assert.equal(railGate("enter", true, null), "open");
    });

    test("leaves every other control in place, so a running interface can still be stopped", () => {
        assert.equal(railGate("other", false, REFUSAL), "open");
        assert.equal(railGate("other", null, null), "open");
    });

    test("holds an enter control back while the rail probe is outstanding", () => {
        assert.equal(railGate("enter", null, null), "pending");
        // Starting the interface does not wait on the probe.
        assert.equal(railGate("start", null, null), "open");
    });

    test("a card refuses only when the stable release it fell back to is absent", () => {
        const wanted = railFor(robot({ describe: "v0.1.0-7-gabc1234-dirty" }));
        const rail = routedRail(wanted, false);
        assert.equal(railGate("enter", false, railNotice(rail, false)), "refused");
        assert.equal(railGate("enter", true, railNotice(rail, true)), "open");
    });
});

suite("a manifest probe caches deployed rails and retries transient faults once", () => {
    test("resolves to deployed when /r/<rail>/manifest.json responds 200", async () => {
        const origin = answering([{ status: 200 }]);
        globalThis.fetch = origin.fetch;
        assert.equal(await probeRail(freshRail()), "deployed");
    });

    test("resolves to absent without retrying on 404 or 410", async () => {
        for (const status of [404, 410]) {
            const origin = answering([{ status }]);
            globalThis.fetch = origin.fetch;
            assert.equal(await probeRail(freshRail()), "absent");
            assert.equal(origin.calls(), 1);
        }
    });

    test("retries a 5xx response once after 1000ms, then resolves to unknown", async (t) => {
        // A transient server error must not report a release as withdrawn ("absent").
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const origin = answering([{ status: 500 }, { status: 500 }]);
        globalThis.fetch = origin.fetch;
        const pending = probeRail(freshRail());
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(1000);
        assert.equal(await pending, "unknown");
        assert.equal(origin.calls(), 2, "an inconclusive probe gets one retry");
    });

    test("retries a network error once after 1000ms, then resolves to unknown", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const origin = answering([{ throws: true }]);
        globalThis.fetch = origin.fetch;
        const pending = probeRail(freshRail());
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(1000);
        assert.equal(await pending, "unknown");
        assert.equal(origin.calls(), 2);
    });

    test("resolves to deployed when the retry succeeds after an initial network failure", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const origin = answering([{ throws: true }, { status: 200 }]);
        globalThis.fetch = origin.fetch;
        const pending = probeRail(freshRail());
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(1000);
        assert.equal(await pending, "deployed");
    });

    test("caches a deployed rail and does not fetch it a second time", async () => {
        const rail = freshRail();
        const origin = answering([{ status: 200 }]);
        globalThis.fetch = origin.fetch;
        assert.equal(await probeRail(rail), "deployed");

        globalThis.fetch = answering([{ throws: true }]).fetch;
        assert.equal(await probeRail(rail), "deployed");
        assert.equal(origin.calls(), 1);
    });

    test("does not cache an absent result so a newly published rail is detected", async () => {
        const rail = freshRail();
        globalThis.fetch = answering([{ status: 404 }]).fetch;
        assert.equal(await probeRail(rail), "absent");

        globalThis.fetch = answering([{ status: 200 }]).fetch;
        assert.equal(await probeRail(rail), "deployed");
    });

    test("deduplicates concurrent probes for the same rail into a single request", async () => {
        const rail = freshRail();
        const origin = answering([{ status: 200 }]);
        globalThis.fetch = origin.fetch;
        const answers = await Promise.all([
            probeRail(rail),
            probeRail(rail),
            probeRail(rail),
        ]);
        assert.deepEqual(answers, ["deployed", "deployed", "deployed"]);
        assert.equal(origin.calls(), 1, "one request for the whole dashboard");
    });

    test("requests /r/<rail>/manifest.json with cache: no-store", async () => {
        const seen = [];
        globalThis.fetch = async (url, init) => {
            seen.push([url, init]);
            return { ok: true, status: 200 };
        };
        const rail = freshRail();
        await probeRail(rail);
        assert.deepEqual(seen[0][0], `/r/${rail}/manifest.json`);
        assert.equal(seen[0][1].cache, "no-store");
    });
});
