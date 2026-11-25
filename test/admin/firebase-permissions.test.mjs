/**
 * Offline unit tests for `firebasePermissions.js` and `firebaseAdminClient.js`:
 * CLI flag parsing, directory classification, disjoint multi-location patch
 * validation, user alias/grant planning, robot binding/config/decommission
 * planning, and REST client wrappers.
 *
 * Live Realtime Database rule enforcement against these paths is covered
 * separately in `test/firebase/firebase-database-rules.test.mjs` (`npm run test:emulated`).
 *
 * Run through `npm run test:admin`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, suite, test } from "node:test";

const require = createRequire(import.meta.url);

const {
    applyRootPatch,
    assertDisjointPatchPaths,
    classifyDirectory,
    createAuthUser,
    deleteAuthUser,
    formatPatchLines,
    listAuthUsers,
    readFirebaseEnv,
    validateRtdbKey,
} = require("../../scripts/firebaseAdminClient.js");

const {
    buildRobotDecommissionPatch,
    buildRobotPermissionsPatch,
    buildUserPermissionsPatch,
    parseArgs,
    validateExtraLocalMaps,
    validateHumanAlias,
} = require("../../scripts/firebasePermissions.js");

/** Temp directories created during tests, removed when the suite completes. */
const tempDirs = [];

after(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * Create a disposable directory under the OS temp root.
 *
 * @param {string} prefix Directory name prefix.
 * @returns {string} Absolute path to the temporary directory.
 */
function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tempDirs.push(dir);
    return dir;
}

/**
 * Build a baseline fixture snapshot with human, aliased human, split-brain human, and robot records.
 *
 * @returns {{
 *   authUsers: {uid: string, email: string, displayName: string, disabled: boolean}[],
 *   uids: Record<string, string>,
 *   assignments: Record<string, Record<string, unknown>>,
 *   robots: Record<string, Record<string, unknown>>,
 *   mapKeys: Record<string, boolean>
 * }} Baseline project snapshot.
 */
function sampleSnapshot() {
    return {
        authUsers: [
            {
                uid: "uid-alice",
                email: "alice@example.com",
                displayName: "Alice",
                disabled: false,
            },
            {
                uid: "uid-bob",
                email: "bob@example.com",
                displayName: "Bob",
                disabled: false,
            },
            {
                uid: "uid-robot-4001",
                email: "stretch-se4-4001@example.com",
                displayName: "",
                disabled: false,
            },
        ],
        uids: {
            "uid-alice": "alice",
        },
        assignments: {
            alice: {
                robots: { "stretch-se4-4001": true },
                maps: { kitchen: true },
            },
            "uid-alice": {
                robots: { "stretch-se4-4001": true, "stretch-se4-4002": true },
                maps: { legacy_lab: true },
            },
            "uid-bob": {
                robots: { "stretch-se4-4002": true },
                maps: { local_hallway: true },
            },
            "uid-robot-4001": {
                role: "robot",
                name: "stretch-se4-4001",
            },
            "stretch-se4-4001": {
                maps: { kitchen: true },
            },
        },
        robots: {
            "stretch-se4-4001": {
                name: "stretch-se4-4001",
                uid: "uid-robot-4001",
                status: "standby",
                build: { describe: "v0.2.0", rail: "v0.2.0" },
                config: { voice_control_interface: true },
            },
            "stretch-se4-4002": {
                name: "stretch-se4-4002",
                status: "offline",
            },
        },
        mapKeys: {
            kitchen: true,
            office: true,
        },
    };
}

suite("firebasePermissions CLI argument parsing", () => {
    let savedDryRun;

    beforeEach(() => {
        savedDryRun = process.env.npm_config_dry_run;
        delete process.env.npm_config_dry_run;
    });

    afterEach(() => {
        if (savedDryRun === undefined) {
            delete process.env.npm_config_dry_run;
        } else {
            process.env.npm_config_dry_run = savedDryRun;
        }
    });

    test("defaults to interactive top-level menu without dry-run", () => {
        assert.deepEqual(parseArgs([]), {
            mode: "menu",
            dryRun: false,
            help: false,
        });
    });

    test("parses --user, --robot, --dry-run, and --help flags", () => {
        assert.deepEqual(parseArgs(["--user", "--dry-run"]), {
            mode: "user",
            dryRun: true,
            help: false,
        });
        assert.deepEqual(parseArgs(["--robot"]), {
            mode: "robot",
            dryRun: false,
            help: false,
        });
        assert.deepEqual(parseArgs(["-h"]), {
            mode: "menu",
            dryRun: false,
            help: true,
        });
    });

    test("honors npm_config_dry_run when npm consumed --dry-run", () => {
        process.env.npm_config_dry_run = "true";
        assert.equal(parseArgs([]).dryRun, true);
    });

    test("rejects combining --user and --robot or unknown arguments", () => {
        assert.throws(
            () => parseArgs(["--user", "--robot"]),
            /--user and --robot cannot be combined/
        );
        assert.throws(
            () => parseArgs(["--bogus"]),
            /unknown argument: --bogus/
        );
        // Positive control: single mode flag succeeds.
        assert.equal(parseArgs(["--user"]).mode, "user");
    });
});

suite("Realtime Database key and disjoint multi-path patch validation", () => {
    test("rejects empty keys and forbidden Realtime Database characters", () => {
        for (const bad of ["", "   ", "a.b", "a$b", "a#b", "a[0]", "a/b"]) {
            assert.throws(
                () => validateRtdbKey(bad, "map ID"),
                /map ID (must not be empty|.*contains characters forbidden)/
            );
        }
        assert.equal(
            validateRtdbKey("stretch-se4-4001", "fleet ID"),
            "stretch-se4-4001"
        );
    });

    test("rejects ancestor/descendant overlapping paths and accepts sibling paths", () => {
        assert.throws(
            () =>
                assertDisjointPatchPaths({
                    "assignments/alice": { robots: { r1: true } },
                    "assignments/alice/robots/r2": null,
                }),
            /overlapping patch paths "assignments\/alice" and "assignments\/alice\/robots\/r2"/
        );
        assert.throws(
            () =>
                assertDisjointPatchPaths({
                    "/assignments/alice/robots/r1": true,
                    "assignments/alice/robots/r1/": false,
                }),
            /duplicate patch path "assignments\/alice\/robots\/r1"/
        );

        const valid = assertDisjointPatchPaths({
            "/assignments/alice": { robots: { r1: true } },
            "/assignments/uid-alice": null,
            "uids/uid-alice": "alice",
        });
        assert.deepEqual(Object.keys(valid).sort(), [
            "assignments/alice",
            "assignments/uid-alice",
            "uids/uid-alice",
        ]);
    });

    test("formatPatchLines summarizes base64 map payloads without dumping raw bytes", () => {
        const lines = formatPatchLines({
            "maps/kitchen": {
                name: "kitchen",
                yaml_content: "image: kitchen.pgm\n",
                pgm_filename: "kitchen.pgm",
                pgm_base64:
                    Buffer.from("P5\n1 1\n255\n\x00").toString("base64"),
            },
            "assignments/alice/maps/old": null,
        });
        assert.equal(lines.length, 2);
        assert.deepEqual(lines[0], {
            mark: "-",
            path: "/assignments/alice/maps/old",
            summary: "DELETE",
        });
        assert.equal(lines[1].mark, "+");
        assert.equal(lines[1].path, "/maps/kitchen");
        assert.match(lines[1].summary, /"pgm_bytes":12/);
        assert.doesNotMatch(lines[1].summary, /pgm_base64/);
    });

    test("assertDisjointPatchPaths handles __proto__ keys without prototype mutation", () => {
        const input = Object.create(null);
        input.__proto__ = true;
        const result = assertDisjointPatchPaths(input);
        assert.equal(Object.prototype.hasOwnProperty.call(result, "__proto__"), true);
        assert.equal(result["__proto__"], true);
        assert.deepEqual(Object.keys(result), ["__proto__"]);
    });
});

suite(
    "classifyDirectory separates human operators from robot machine accounts",
    () => {
        test("excludes robot machine accounts from humans and detects split assignments and binding health", () => {
            const dir = classifyDirectory(sampleSnapshot());

            assert.deepEqual(
                dir.humans.map((h) => h.identity),
                ["alice", "uid-bob"]
            );

            const alice = dir.humans.find((h) => h.identity === "alice");
            assert.equal(alice.hasSplitAssignments, true);
            assert.deepEqual(alice.assignedRobots, [
                "stretch-se4-4001",
                "stretch-se4-4002",
            ]);
            assert.deepEqual(alice.assignedMaps, ["kitchen", "legacy_lab"]);

            assert.deepEqual(
                dir.robots.map((r) => ({
                    fleetId: r.fleetId,
                    consistent: r.bindingConsistent,
                })),
                [
                    { fleetId: "stretch-se4-4001", consistent: true },
                    { fleetId: "stretch-se4-4002", consistent: false },
                ]
            );

            assert.deepEqual(dir.cloudMapIds, ["kitchen", "office"]);
            assert.deepEqual(dir.mapIds, [
                "kitchen",
                "legacy_lab",
                "local_hallway",
                "office",
            ]);
        });
    }
);

suite(
    "buildUserPermissionsPatch enforces alias and revocation invariants",
    () => {
        test("unchecking grants deletes them from both alias and authUid while healing split duplicates", () => {
            const snapshot = sampleSnapshot();
            const patch = buildUserPermissionsPatch({
                snapshot,
                uid: "uid-alice",
                currentAlias: "alice",
                targetAlias: "alice",
                selectedRobots: ["stretch-se4-4001"],
                selectedMaps: ["office"],
            });

            assert.deepEqual(patch, {
                // Kept on alias, duplicate under uid-alice removed:
                "assignments/uid-alice/robots/stretch-se4-4001": null,
                // Unchecked robot removed from uid-alice:
                "assignments/uid-alice/robots/stretch-se4-4002": null,
                // Unchecked maps removed from both alias and uid-alice:
                "assignments/alice/maps/kitchen": null,
                "assignments/uid-alice/maps/legacy_lab": null,
                // Newly checked map added to canonical alias:
                "assignments/alice/maps/office": true,
            });
        });

        test("migrating an unaliased user to a new alias moves grants, sets uids/<uid>, and deletes assignments/<uid>", () => {
            const snapshot = sampleSnapshot();
            const patch = buildUserPermissionsPatch({
                snapshot,
                uid: "uid-bob",
                currentAlias: null,
                targetAlias: "bob_op",
                selectedRobots: ["stretch-se4-4002"],
                selectedMaps: ["kitchen"],
            });

            assert.deepEqual(patch, {
                "assignments/bob_op": {
                    robots: { "stretch-se4-4002": true },
                    maps: { kitchen: true },
                },
                "uids/uid-bob": "bob_op",
                "assignments/uid-bob": null,
            });
        });

        test("rejects human aliases that collide with robots, machine accounts, or other users", () => {
            const snapshot = sampleSnapshot();
            assert.throws(
                () =>
                    validateHumanAlias("stretch-se4-4001", "uid-bob", snapshot),
                /collides with existing robot fleet ID/
            );
            assert.throws(
                () => validateHumanAlias("uid-robot-4001", "uid-bob", snapshot),
                /collides with robot machine account/
            );
            assert.throws(
                () => validateHumanAlias("alice", "uid-bob", snapshot),
                /already assigned to Auth UID "uid-alice"/
            );
            assert.throws(
                () => validateHumanAlias("uid-alice", "uid-bob", snapshot),
                /collides with another user's Auth UID/
            );
            // Positive control: unused alias for uid-bob succeeds.
            assert.equal(
                validateHumanAlias("bob_team", "uid-bob", snapshot),
                "bob_team"
            );
        });

        test("revoking a map clears legacy owner_uid and allowed_users on /maps/<mapId> when present", () => {
            const snapshot = {
                ...sampleSnapshot(),
                mapAccess: {
                    kitchen: {
                        owner_uid: "alice",
                        allowed_users: {
                            alice: true,
                            "uid-alice": true,
                            "uid-bob": true,
                        },
                    },
                },
            };

            const patch = buildUserPermissionsPatch({
                snapshot,
                uid: "uid-alice",
                currentAlias: "alice",
                targetAlias: "alice",
                selectedRobots: ["stretch-se4-4001", "stretch-se4-4002"],
                selectedMaps: ["legacy_lab"],
            });

            assert.equal(patch["assignments/alice/maps/kitchen"], null);
            assert.equal(patch["maps/kitchen/owner_uid"], null);
            assert.equal(patch["maps/kitchen/allowed_users/alice"], null);
            assert.equal(patch["maps/kitchen/allowed_users/uid-alice"], null);
            assert.equal(
                patch["maps/kitchen/allowed_users/uid-bob"],
                undefined
            );
        });

        test("validateExtraLocalMaps accepts valid comma-separated stems and rejects invalid RTDB keys", () => {
            assert.equal(validateExtraLocalMaps(""), true);
            assert.equal(validateExtraLocalMaps("  lab_1 , hallway_2 "), true);
            assert.match(
                validateExtraLocalMaps("good_map, bad.map"),
                /forbidden in Realtime Database keys/
            );
            assert.match(
                validateExtraLocalMaps("foo/bar"),
                /forbidden in Realtime Database keys/
            );
        });
    }
);

suite("buildRobotPermissionsPatch and buildRobotDecommissionPatch", () => {
    const declaredFeatures = {
        voice_control_interface: { enabled: false },
        local_collision_avoidance: { enabled: true },
    };

    test("binds a robot, updates user/map grants across aliases, and writes changed feature flags", () => {
        const snapshot = sampleSnapshot();
        const directory = classifyDirectory(snapshot);

        const patch = buildRobotPermissionsPatch({
            snapshot,
            directory,
            fleetId: "stretch-se4-4001",
            robotUid: "uid-robot-4001",
            // Uncheck alice (must remove from BOTH alice and uid-alice) and check uid-bob:
            selectedUserIdentities: ["uid-bob"],
            selectedMaps: ["office"],
            // Turn off voice_control_interface (currently true) and keep local_collision_avoidance true (default):
            selectedFeatureFlags: ["local_collision_avoidance"],
            declaredFeatures,
        });

        assert.deepEqual(patch, {
            "assignments/alice/robots/stretch-se4-4001": null,
            "assignments/uid-alice/robots/stretch-se4-4001": null,
            "assignments/uid-bob/robots/stretch-se4-4001": true,
            "assignments/stretch-se4-4001/maps/kitchen": null,
            "assignments/stretch-se4-4001/maps/office": true,
            "robots/stretch-se4-4001/config/voice_control_interface": false,
        });
    });

    test("rejects binding a robot Auth UID that is already bound to a different robot", () => {
        const snapshot = sampleSnapshot();
        const directory = classifyDirectory(snapshot);

        assert.throws(
            () =>
                buildRobotPermissionsPatch({
                    snapshot,
                    directory,
                    fleetId: "stretch-se4-4099",
                    robotUid: "uid-robot-4001",
                    selectedUserIdentities: [],
                    selectedMaps: [],
                    selectedFeatureFlags: [],
                    declaredFeatures,
                }),
            /already bound to robot "stretch-se4-4001"/
        );

        // Positive control: distinct fresh robot UID succeeds and stages the 2-row binding.
        const validPatch = buildRobotPermissionsPatch({
            snapshot,
            directory,
            fleetId: "stretch-se4-4099",
            robotUid: "uid-robot-4099",
            selectedUserIdentities: [],
            selectedMaps: [],
            selectedFeatureFlags: ["local_collision_avoidance"],
            declaredFeatures,
        });
        assert.deepEqual(validPatch["assignments/uid-robot-4099"], {
            role: "robot",
            name: "stretch-se4-4099",
        });
        assert.equal(
            validPatch["robots/stretch-se4-4099/uid"],
            "uid-robot-4099"
        );
        assert.equal(
            validPatch["robots/stretch-se4-4099/name"],
            "stretch-se4-4099"
        );
    });

    test("decommissioning a robot removes robot, logs, room, machine assignment, and all operator grants", () => {
        const snapshot = sampleSnapshot();
        const { patch, robotUid } = buildRobotDecommissionPatch({
            snapshot,
            fleetId: "stretch-se4-4001",
        });

        assert.equal(robotUid, "uid-robot-4001");
        assert.deepEqual(patch, {
            "robots/stretch-se4-4001": null,
            "launch_logs/stretch-se4-4001": null,
            "assignments/stretch-se4-4001": null,
            "assignments/uid-robot-4001": null,
            "rooms/uid-robot-4001": null,
            "assignments/alice/robots/stretch-se4-4001": null,
            "assignments/uid-alice/robots/stretch-se4-4001": null,
        });
    });

    test("rebinding an existing fleetId to a new Auth UID clears the previous robot UID assignment and room", () => {
        const snapshot = sampleSnapshot();
        const directory = classifyDirectory(snapshot);

        const patch = buildRobotPermissionsPatch({
            snapshot,
            directory,
            fleetId: "stretch-se4-4001",
            robotUid: "uid-robot-new",
            selectedUserIdentities: ["alice"],
            selectedMaps: ["kitchen"],
            selectedFeatureFlags: ["voice_control_interface", "local_collision_avoidance"],
            declaredFeatures,
        });

        assert.deepEqual(patch["assignments/uid-robot-new"], {
            role: "robot",
            name: "stretch-se4-4001",
        });
        assert.equal(patch["robots/stretch-se4-4001/uid"], "uid-robot-new");
        assert.equal(patch["assignments/uid-robot-4001"], null);
        assert.equal(patch["rooms/uid-robot-4001"], null);
    });

    test("revoking a cloud map from a robot clears legacy owner_uid and allowed_users on /maps/<mapId>", () => {
        const snapshot = {
            ...sampleSnapshot(),
            mapAccess: {
                kitchen: {
                    owner_uid: "stretch-se4-4001",
                    allowed_users: {
                        "stretch-se4-4001": true,
                        alice: true,
                    },
                },
            },
        };
        const directory = classifyDirectory(snapshot);

        const patch = buildRobotPermissionsPatch({
            snapshot,
            directory,
            fleetId: "stretch-se4-4001",
            robotUid: "uid-robot-4001",
            selectedUserIdentities: ["alice"],
            selectedMaps: [],
            selectedFeatureFlags: ["voice_control_interface", "local_collision_avoidance"],
            declaredFeatures,
        });

        assert.equal(patch["assignments/stretch-se4-4001/maps/kitchen"], null);
        assert.equal(patch["maps/kitchen/owner_uid"], null);
        assert.equal(
            patch["maps/kitchen/allowed_users/stretch-se4-4001"],
            null
        );
        assert.equal(patch["maps/kitchen/allowed_users/alice"], undefined);
    });
});

suite("firebaseAdminClient env and REST wrappers", () => {
    let savedProjectId;
    let savedDbUrl;

    beforeEach(() => {
        savedProjectId = process.env.PUBLIC_FIREBASE_PROJECT_ID;
        savedDbUrl = process.env.PUBLIC_FIREBASE_DATABASE_URL;
        delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        delete process.env.PUBLIC_FIREBASE_DATABASE_URL;
    });

    afterEach(() => {
        if (savedProjectId === undefined) {
            delete process.env.PUBLIC_FIREBASE_PROJECT_ID;
        } else {
            process.env.PUBLIC_FIREBASE_PROJECT_ID = savedProjectId;
        }
        if (savedDbUrl === undefined) {
            delete process.env.PUBLIC_FIREBASE_DATABASE_URL;
        } else {
            process.env.PUBLIC_FIREBASE_DATABASE_URL = savedDbUrl;
        }
    });

    test("readFirebaseEnv validates required keys and normalizes databaseOrigin", () => {
        const emptyRoot = makeTempDir("empty-env");
        assert.throws(
            () => readFirebaseEnv(emptyRoot),
            /PUBLIC_FIREBASE_PROJECT_ID is not set/
        );

        fs.writeFileSync(
            path.join(emptyRoot, ".env"),
            "PUBLIC_FIREBASE_PROJECT_ID=my-proj\nPUBLIC_FIREBASE_DATABASE_URL=not-a-url\n"
        );
        assert.throws(
            () => readFirebaseEnv(emptyRoot),
            /PUBLIC_FIREBASE_DATABASE_URL is not a valid URL/
        );

        fs.writeFileSync(
            path.join(emptyRoot, ".env"),
            "PUBLIC_FIREBASE_PROJECT_ID=my-proj\nPUBLIC_FIREBASE_DATABASE_URL=https://my-proj-default-rtdb.firebaseio.com/\nPUBLIC_FIREBASE_API_KEY=key123\n"
        );
        assert.deepEqual(readFirebaseEnv(emptyRoot), {
            projectId: "my-proj",
            databaseOrigin: "https://my-proj-default-rtdb.firebaseio.com",
            apiKey: "key123",
        });
    });

    test("listAuthUsers paginates batchGet and createAuthUser/deleteAuthUser validate inputs", async () => {
        const calls = [];
        const stubAuthClient = {
            request: async (req) => {
                calls.push(req);
                if (req.path.endsWith(":batchGet")) {
                    if (!req.queryParams.nextPageToken) {
                        return {
                            body: {
                                users: [
                                    {
                                        localId: "u1",
                                        email: "one@example.com",
                                    },
                                ],
                                nextPageToken: "page-2",
                            },
                        };
                    }
                    return {
                        body: {
                            users: [
                                { localId: "u2", email: "two@example.com" },
                            ],
                        },
                    };
                }
                if (req.path.endsWith("/accounts")) {
                    return {
                        body: { localId: "u3", email: req.body.email },
                    };
                }
                return { body: {} };
            },
        };

        const listed = await listAuthUsers("proj-1", stubAuthClient);
        assert.equal(listed.length, 2);
        assert.deepEqual(
            listed.map((u) => u.uid),
            ["u1", "u2"]
        );

        await assert.rejects(
            () =>
                createAuthUser("proj-1", "invalid-email", "secret123", {
                    authClient: stubAuthClient,
                }),
            /invalid email address/
        );
        await assert.rejects(
            () =>
                createAuthUser("proj-1", "three@example.com", "12345", {
                    authClient: stubAuthClient,
                }),
            /password must be at least 6 characters/
        );

        const created = await createAuthUser(
            "proj-1",
            "three@example.com",
            "secret123",
            { authClient: stubAuthClient }
        );
        assert.deepEqual(created, { uid: "u3", email: "three@example.com" });
        const createCall = calls.find((c) => c.path.endsWith("/accounts"));
        assert.equal(createCall?.queryParams, undefined);

        await assert.rejects(
            () => deleteAuthUser("proj-1", "   ", stubAuthClient),
            /Auth uid must not be empty/
        );
        await assert.doesNotReject(() =>
            deleteAuthUser("proj-1", "u3", stubAuthClient)
        );
    });

    test("applyRootPatch skips empty patches, sends PATCH /.json, and surfaces HTTP errors", async () => {
        const sent = [];
        const okClient = {
            request: async (req) => {
                sent.push(req);
                return { status: 200, body: req.body };
            },
        };

        assert.equal(await applyRootPatch(okClient, {}), false);
        assert.equal(sent.length, 0);

        assert.equal(
            await applyRootPatch(okClient, {
                "assignments/alice/robots/r1": true,
            }),
            true
        );
        assert.equal(sent.length, 1);
        assert.equal(sent[0].method, "PATCH");
        assert.equal(sent[0].path, "/.json");

        const failClient = {
            request: async () => ({
                status: 403,
                body: { error: "Permission denied" },
            }),
        };
        await assert.rejects(
            () =>
                applyRootPatch(failClient, {
                    "assignments/alice/robots/r1": true,
                }),
            (err) =>
                err.message === "atomic Realtime Database PATCH failed" &&
                err.cause?.message === "Permission denied"
        );
    });
});
