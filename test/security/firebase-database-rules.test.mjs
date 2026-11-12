/**
 * database.rules.json exercised against the Realtime Database emulator.
 *
 * Run through `npm run test:firebase-rules`, which starts the emulator and
 * supplies the demo project id this file expects. The rules are uploaded from
 * the repository copy, so a case here fails on the file that would be deployed.
 *
 * A passing run prints a FIREBASE WARNING line for every write the rules were
 * meant to refuse. They are the client SDK reporting a denial, not failures:
 * there is one per refusal, and the writes that are meant to succeed print
 * none. A run with no warnings at all would be the thing to look into.
 *
 * The database answers every refusal with PERMISSION_DENIED, whether a .write
 * rule refused the writer or a .validate rule refused the value. assertFails
 * therefore cannot say which happened, and a case that only refuses is a case
 * that would still pass if the rule it names were deleted and some other rule
 * did the refusing. Each refusal here is paired with the nearest write that
 * must still succeed, so the pair locates the rule between them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, suite, test } from "node:test";

import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const PROJECT_ID = "demo-interface-rules";
const RULES_PATH = new URL("../../database.rules.json", import.meta.url);

const FLEET_ID = "stretch-se4-9999";
const OTHER_FLEET_ID = "stretch-se4-0001";
const ROBOT_UID = "robot-auth-uid";
const OTHER_ROBOT_UID = "other-robot-auth-uid";
const OPERATOR_UID = "operator-auth-uid";
const STRANGER_UID = "stranger-auth-uid";

/** A release build: on a tag, clean tree. */
const TAGGED_BUILD = { describe: "v0.4.2", rail: "v0.4.2" };

/** A development build: no tag, so no rail. */
const UNTAGGED_BUILD = { describe: "74bce18a-dirty" };

let testEnv;

/**
 * Address of the running database emulator.
 *
 * emulators:exec exports FIREBASE_DATABASE_EMULATOR_HOST. The fallback matches
 * the port in firebase.json for a hand-started emulator.
 *
 * @returns {{host: string, port: number}} Emulator host and port.
 */
function emulatorAddress() {
    const fromEnv = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
    if (!fromEnv) {
        return { host: "127.0.0.1", port: 9000 };
    }
    const [host, port] = fromEnv.split(":");
    return { host, port: Number(port) };
}

/**
 * Write the assignment and robot records the rules read when they evaluate.
 *
 * Every robots/$fleetId rule checks the writer's role and name under
 * assignments, and the robot's own uid under robots/$fleetId/uid, so a test
 * that skips this is denied for the wrong reason.
 *
 * @returns {Promise<void>} Resolves once the records are in place.
 */
async function seedFleet() {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.database().ref().set({
            assignments: {
                [ROBOT_UID]: { role: "robot", name: FLEET_ID },
                [OTHER_ROBOT_UID]: { role: "robot", name: OTHER_FLEET_ID },
                [OPERATOR_UID]: { robots: { [FLEET_ID]: true } },
            },
            robots: {
                [FLEET_ID]: {
                    uid: ROBOT_UID,
                    name: FLEET_ID,
                    status: "standby",
                },
                [OTHER_FLEET_ID]: {
                    uid: OTHER_ROBOT_UID,
                    name: OTHER_FLEET_ID,
                    status: "standby",
                },
            },
        });
    });
}

/**
 * Read a path with the rules switched off.
 *
 * @param {string} path Database path to read.
 * @returns {Promise<unknown>} The stored value, or null when the path is empty.
 */
async function readAsAdmin(path) {
    let value = null;
    await testEnv.withSecurityRulesDisabled(async (context) => {
        const snapshot = await context.database().ref(path).once("value");
        value = snapshot.val();
    });
    return value;
}

/**
 * Database handle authenticated as one uid.
 *
 * @param {string} uid Auth uid to sign the requests with.
 * @returns {import("firebase/compat/app").default.database.Database} Handle.
 */
function asUser(uid) {
    return testEnv.authenticatedContext(uid).database();
}

before(async () => {
    const { host, port } = emulatorAddress();
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        database: {
            host,
            port,
            rules: readFileSync(RULES_PATH, "utf8"),
        },
    });
});

after(async () => {
    await testEnv?.cleanup();
});

beforeEach(async () => {
    await testEnv.clearDatabase();
    await seedFleet();
});

suite("only the assigned robot may write a valid build record", () => {
    test("the robot publishes its own tagged build", async () => {
        await assertSucceeds(
            asUser(ROBOT_UID).ref(`robots/${FLEET_ID}/build`).set(TAGGED_BUILD),
        );
    });

    test("the robot publishes an untagged build with no rail", async () => {
        await assertSucceeds(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set(UNTAGGED_BUILD),
        );
    });

    test("overwriting a tagged build with an untagged build clears rail", async () => {
        await assertSucceeds(
            asUser(ROBOT_UID).ref(`robots/${FLEET_ID}/build`).set(TAGGED_BUILD),
        );
        await assertSucceeds(
            asUser(ROBOT_UID).ref(`robots/${FLEET_ID}/build`).set(UNTAGGED_BUILD),
        );
        assert.deepEqual(
            await readAsAdmin(`robots/${FLEET_ID}/build`),
            UNTAGGED_BUILD,
        );
    });

    test("a build payload without describe is refused", async () => {
        await assertFails(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ rail: "v0.4.2" }),
        );

        // Positive control: adding describe to the same rail succeeds.
        await assertSucceeds(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set(TAGGED_BUILD),
        );
    });

    test("a rail that is not a release tag is refused", async () => {
        // rail becomes a URL path segment in the lobby, so anything outside the
        // tag grammar is rejected here rather than encoded away in the browser.
        for (const rail of [
            "../../evil",
            "v1.0.0/../x",
            "main",
            "https://example.com",
            "v1.0",
        ]) {
            await assertFails(
                asUser(ROBOT_UID)
                    .ref(`robots/${FLEET_ID}/build`)
                    .set({ describe: "v1.0.0", rail }),
            );
        }

        // The same writer, the same path, the same shape, one valid rail: this
        // is what makes the refusals above evidence about the rail rather than
        // about the writer. Without it, taking .write away from build entirely
        // would leave every case above passing.
        await assertSucceeds(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ describe: "v1.0.0", rail: "v1.0.0" }),
        );
    });

    test("a describe past the length cap is refused", async () => {
        await assertFails(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ describe: "v".repeat(129) }),
        );

        // One character shorter is the longest describe the rules accept, so
        // the pair puts the cap where it is written rather than somewhere
        // under it, and shows the refusal above was the length and not the
        // writer.
        await assertSucceeds(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ describe: "v".repeat(128) }),
        );
    });

    test("an unrecognised field under build is refused", async () => {
        await assertFails(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ describe: "v1.0.0", channel: "branch-main" }),
        );

        // The same write without the field it does not know is accepted, so
        // what was refused above is the extra field.
        await assertSucceeds(
            asUser(ROBOT_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set({ describe: "v1.0.0" }),
        );
    });

    test("a robot cannot write another robot's build", async () => {
        await assertFails(
            asUser(ROBOT_UID)
                .ref(`robots/${OTHER_FLEET_ID}/build`)
                .set(TAGGED_BUILD),
        );

        // Positive control: the robot assigned to OTHER_FLEET_ID can write it.
        await assertSucceeds(
            asUser(OTHER_ROBOT_UID)
                .ref(`robots/${OTHER_FLEET_ID}/build`)
                .set(TAGGED_BUILD),
        );
    });

    test("an assigned operator cannot write the build", async () => {
        await assertFails(
            asUser(OPERATOR_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .set(TAGGED_BUILD),
        );
    });

    test("a signed-out client cannot write the build", async () => {
        await assertFails(
            testEnv
                .unauthenticatedContext()
                .database()
                .ref(`robots/${FLEET_ID}/build`)
                .set(TAGGED_BUILD),
        );
    });

    test("an assigned operator can read the build", async () => {
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await context
                .database()
                .ref(`robots/${FLEET_ID}/build`)
                .set(TAGGED_BUILD);
        });
        await assertSucceeds(
            asUser(OPERATOR_UID)
                .ref(`robots/${FLEET_ID}/build`)
                .once("value"),
        );
    });

    test("an unassigned user cannot read the robot", async () => {
        await assertFails(
            asUser(STRANGER_UID).ref(`robots/${FLEET_ID}`).once("value"),
        );
    });
});

suite("an invalid build in a multi-path update rejects the entire update", () => {
    test("a rejected build in a status update discards the status", async () => {
        // update() is atomic. The daemon publishes build in a call of its own so
        // that a rejected build cannot stop the robot reporting its status.
        await assertFails(
            asUser(ROBOT_UID).ref(`robots/${FLEET_ID}`).update({
                status: "online",
                last_updated: Date.now(),
                build: { describe: "v1.0.0", rail: "not-a-tag" },
            }),
        );

        assert.equal(await readAsAdmin(`robots/${FLEET_ID}/status`), "standby");
        assert.equal(await readAsAdmin(`robots/${FLEET_ID}/build`), null);
    });

    test("a status update without a build is accepted", async () => {
        await assertSucceeds(
            asUser(ROBOT_UID).ref(`robots/${FLEET_ID}`).update({
                status: "online",
                name: FLEET_ID,
                uid: ROBOT_UID,
                last_updated: Date.now(),
            }),
        );

        assert.equal(await readAsAdmin(`robots/${FLEET_ID}/status`), "online");
    });
});
