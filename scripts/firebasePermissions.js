#!/usr/bin/env node

/**
 * Interactive CLI for managing Firebase user permissions, aliases, robot
 * bindings, per-robot feature flags, and robot decommissioning.
 *
 * Usage:
 *   npm run firebase:permissions
 *   npm run firebase:permissions -- --user
 *   npm run firebase:permissions -- --robot
 *   npm run firebase:permissions -- --dry-run
 */

const fs = require("node:fs");
const path = require("node:path");

const {
    checkbox,
    confirm,
    input,
    password: promptPassword,
    select,
} = require("firebase-tools/lib/prompt");

const {
    appendLegacyMapRevocations,
    applyRootPatch,
    assertDisjointPatchPaths,
    authenticateAdmin,
    classifyDirectory,
    createAdminClients,
    createAuthUser,
    deleteAuthUser,
    fetchAdminSnapshot,
    fetchMapAccessMetadata,
    isPlainObject,
    printPatchPreview,
    readFirebaseEnv,
    validateRtdbKey,
} = require("./firebaseAdminClient");

const defaultRepoRoot = path.join(__dirname, "..");
const ADD_NEW_SENTINEL = "__ADD_NEW__";

const USAGE = `Usage: npm run firebase:permissions [-- [options]]

Interactive permissions manager for Firebase operators and robots.

Options:
  --user       Open the user permissions workflow directly
  --robot      Open the robot management workflow directly
  --dry-run    Preview Realtime Database changes without applying them
  -h, --help   Print this help message`;

/**
 * Parse command-line flags for `firebasePermissions.js`.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{mode: "menu" | "user" | "robot", dryRun: boolean, help: boolean}} Parsed options.
 * @throws {Error} When unknown or mutually exclusive flags are passed.
 */
function parseArgs(argv) {
    let mode = "menu";
    let dryRun = Boolean(process.env.npm_config_dry_run);
    let help = false;

    for (const arg of argv) {
        if (arg === "--user") {
            if (mode === "robot") {
                throw new Error("--user and --robot cannot be combined");
            }
            mode = "user";
        } else if (arg === "--robot") {
            if (mode === "user") {
                throw new Error("--user and --robot cannot be combined");
            }
            mode = "robot";
        } else if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "-h" || arg === "--help") {
            help = true;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    return { mode, dryRun, help };
}

/**
 * Load declared feature flag defaults and descriptions from `features.json`.
 *
 * @param {string} [root] Repository root containing `features.json`.
 * @returns {Record<string, {enabled: boolean, description: string}>} Declared feature entries.
 */
function loadDeclaredFeatures(root = defaultRepoRoot) {
    const file = path.join(root, "features.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [flag, entry] of Object.entries(raw)) {
        if (isPlainObject(entry)) {
            out[flag] = {
                enabled: Boolean(entry.enabled),
                description:
                    typeof entry.description === "string"
                        ? entry.description
                        : "",
            };
        }
    }
    return out;
}

/**
 * Validate comma-separated robot-local map stems entered at the prompt.
 *
 * @param {string} raw Comma-separated map ID input.
 * @returns {true | string} `true` when valid, or an error message string.
 */
function validateExtraLocalMaps(raw) {
    if (!raw || !raw.trim()) return true;
    const stems = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    for (const stem of stems) {
        try {
            validateRtdbKey(stem, "map ID");
        } catch (err) {
            return err.message;
        }
    }
    return true;
}

/**
 * Check that a proposed human alias does not collide with robots or other users.
 *
 * @param {string} targetAlias Candidate alias string.
 * @param {string | null} currentUid Auth UID of the user being edited (or null for standalone).
 * @param {{
 *   uids?: Record<string, string>,
 *   assignments?: Record<string, Record<string, unknown>>,
 *   robots?: Record<string, Record<string, unknown>>,
 *   authUsers?: {uid: string, email: string}[]
 * }} snapshot Raw project snapshot.
 * @returns {string} Validated trimmed alias.
 * @throws {Error} When the alias is invalid or collides with an existing robot or user.
 */
function validateHumanAlias(targetAlias, currentUid, snapshot) {
    const clean = validateRtdbKey(targetAlias, "alias");
    const robots = isPlainObject(snapshot.robots) ? snapshot.robots : {};
    const assignments = isPlainObject(snapshot.assignments)
        ? snapshot.assignments
        : {};
    const uids = isPlainObject(snapshot.uids) ? snapshot.uids : {};
    const authUsers = Array.isArray(snapshot.authUsers)
        ? snapshot.authUsers
        : [];

    if (Object.prototype.hasOwnProperty.call(robots, clean)) {
        throw new Error(
            `alias "${clean}" collides with existing robot fleet ID "${clean}"`
        );
    }
    if (
        isPlainObject(assignments[clean]) &&
        assignments[clean].role === "robot"
    ) {
        throw new Error(
            `alias "${clean}" collides with robot machine account "${clean}"`
        );
    }
    for (const user of authUsers) {
        if (user.uid !== currentUid && user.uid === clean) {
            throw new Error(
                `alias "${clean}" collides with another user's Auth UID`
            );
        }
    }
    for (const [uid, alias] of Object.entries(uids)) {
        if (uid !== currentUid && alias === clean) {
            throw new Error(
                `alias "${clean}" is already assigned to Auth UID "${uid}"`
            );
        }
    }

    return clean;
}

/**
 * Build an atomic multi-location patch updating a human operator's alias, robot grants, and map grants.
 *
 * Unchecked grants are deleted from both `<alias>` and `<authUid>` so stale UID grants
 * cannot authorize access through `database.rules.json`.
 *
 * @param {{
 *   snapshot: {
 *     uids?: Record<string, string>,
 *     assignments?: Record<string, Record<string, unknown>>,
 *     robots?: Record<string, Record<string, unknown>>,
 *     authUsers?: {uid: string, email: string}[]
 *   },
 *   uid: string | null,
 *   currentAlias: string | null,
 *   targetAlias: string | null,
 *   selectedRobots: string[],
 *   selectedMaps: string[]
 * }} params Desired user state.
 * @returns {Record<string, unknown>} Disjoint multi-location RTDB patch.
 */
function buildUserPermissionsPatch(params) {
    const { snapshot, uid, currentAlias } = params;
    const assignments = isPlainObject(snapshot.assignments)
        ? snapshot.assignments
        : {};
    const cleanTargetAlias =
        typeof params.targetAlias === "string" && params.targetAlias.trim()
            ? validateHumanAlias(params.targetAlias, uid, snapshot)
            : null;

    if (!uid && !cleanTargetAlias && !currentAlias) {
        throw new Error("user must have either an Auth UID or an alias");
    }

    const selectedRobotSet = new Set(
        params.selectedRobots.map((r) => validateRtdbKey(r, "robot fleet ID"))
    );
    const selectedMapSet = new Set(
        params.selectedMaps.map((m) => validateRtdbKey(m, "map ID"))
    );

    const targetIdentity = cleanTargetAlias || uid || currentAlias;
    const aliasChanged = Boolean(
        uid && cleanTargetAlias !== (currentAlias || null)
    );
    const patch = {};

    if (aliasChanged) {
        const preserved = {};
        for (const sourceKey of [uid, currentAlias, targetIdentity]) {
            if (!sourceKey || !isPlainObject(assignments[sourceKey])) continue;
            for (const [k, v] of Object.entries(assignments[sourceKey])) {
                if (k !== "robots" && k !== "maps") {
                    preserved[k] = v;
                }
            }
        }

        const robotsNode = {};
        for (const r of [...selectedRobotSet].sort()) robotsNode[r] = true;
        const mapsNode = {};
        for (const m of [...selectedMapSet].sort()) mapsNode[m] = true;

        const nextNode = { ...preserved };
        if (Object.keys(robotsNode).length > 0) nextNode.robots = robotsNode;
        if (Object.keys(mapsNode).length > 0) nextNode.maps = mapsNode;

        patch[`assignments/${targetIdentity}`] =
            Object.keys(nextNode).length > 0 ? nextNode : null;
        patch[`uids/${uid}`] = cleanTargetAlias;

        if (uid !== targetIdentity && assignments[uid] !== undefined) {
            patch[`assignments/${uid}`] = null;
        }
        if (
            currentAlias &&
            currentAlias !== targetIdentity &&
            currentAlias !== uid &&
            assignments[currentAlias] !== undefined
        ) {
            patch[`assignments/${currentAlias}`] = null;
        }

        return assertDisjointPatchPaths(patch);
    }

    const keysToClean =
        uid && uid !== targetIdentity
            ? [targetIdentity, uid]
            : [targetIdentity];

    const existingRobots = new Set();
    const existingMaps = new Set();
    for (const k of keysToClean) {
        if (!isPlainObject(assignments[k])) continue;
        if (isPlainObject(assignments[k].robots)) {
            for (const r of Object.keys(assignments[k].robots)) {
                existingRobots.add(r);
            }
        }
        if (isPlainObject(assignments[k].maps)) {
            for (const m of Object.keys(assignments[k].maps)) {
                existingMaps.add(m);
            }
        }
    }

    for (const r of [
        ...new Set([...existingRobots, ...selectedRobotSet]),
    ].sort()) {
        if (selectedRobotSet.has(r)) {
            if (assignments[targetIdentity]?.robots?.[r] !== true) {
                patch[`assignments/${targetIdentity}/robots/${r}`] = true;
            }
            if (
                uid &&
                uid !== targetIdentity &&
                assignments[uid]?.robots?.[r] !== undefined
            ) {
                patch[`assignments/${uid}/robots/${r}`] = null;
            }
        } else {
            for (const k of keysToClean) {
                if (assignments[k]?.robots?.[r] !== undefined) {
                    patch[`assignments/${k}/robots/${r}`] = null;
                }
            }
        }
    }

    for (const m of [...new Set([...existingMaps, ...selectedMapSet])].sort()) {
        if (selectedMapSet.has(m)) {
            if (assignments[targetIdentity]?.maps?.[m] !== true) {
                patch[`assignments/${targetIdentity}/maps/${m}`] = true;
            }
            if (
                uid &&
                uid !== targetIdentity &&
                assignments[uid]?.maps?.[m] !== undefined
            ) {
                patch[`assignments/${uid}/maps/${m}`] = null;
            }
        } else {
            for (const k of keysToClean) {
                if (assignments[k]?.maps?.[m] !== undefined) {
                    patch[`assignments/${k}/maps/${m}`] = null;
                }
            }
            appendLegacyMapRevocations(patch, snapshot.mapAccess, m, keysToClean);
        }
    }

    return assertDisjointPatchPaths(patch);
}

/**
 * Build an atomic multi-location patch binding a robot and updating its operators, maps, and feature flags.
 *
 * @param {{
 *   snapshot: {
 *     uids?: Record<string, string>,
 *     assignments?: Record<string, Record<string, unknown>>,
 *     robots?: Record<string, Record<string, unknown>>,
 *     authUsers?: {uid: string, email: string}[]
 *   },
 *   directory: ReturnType<typeof classifyDirectory>,
 *   fleetId: string,
 *   robotUid: string,
 *   selectedUserIdentities: string[],
 *   selectedMaps: string[],
 *   selectedFeatureFlags: string[],
 *   declaredFeatures: Record<string, {enabled: boolean, description?: string}>
 * }} params Desired robot state.
 * @returns {Record<string, unknown>} Disjoint multi-location RTDB patch.
 * @throws {Error} When `fleetId` or `robotUid` is invalid or collides with another entity.
 */
function buildRobotPermissionsPatch(params) {
    const cleanFleetId = validateRtdbKey(params.fleetId, "robot fleet ID");
    const cleanRobotUid = validateRtdbKey(params.robotUid, "robot Auth UID");
    if (cleanFleetId === cleanRobotUid) {
        throw new Error("robot fleet ID and robot Auth UID must be distinct");
    }

    const assignments = isPlainObject(params.snapshot.assignments)
        ? params.snapshot.assignments
        : {};
    const robots = isPlainObject(params.snapshot.robots)
        ? params.snapshot.robots
        : {};

    // Prevent binding one Auth UID to two different robots or stealing a human's identity.
    const existingRoleRec = assignments[cleanRobotUid];
    if (
        isPlainObject(existingRoleRec) &&
        existingRoleRec.role === "robot" &&
        typeof existingRoleRec.name === "string" &&
        existingRoleRec.name !== cleanFleetId
    ) {
        throw new Error(
            `Auth UID "${cleanRobotUid}" is already bound to robot "${existingRoleRec.name}"`
        );
    }
    for (const [otherFleet, rec] of Object.entries(robots)) {
        if (
            otherFleet !== cleanFleetId &&
            isPlainObject(rec) &&
            rec.uid === cleanRobotUid
        ) {
            throw new Error(
                `Auth UID "${cleanRobotUid}" is already referenced by robots/${otherFleet}/uid`
            );
        }
    }
    for (const human of params.directory.humans) {
        if (human.identity === cleanFleetId || human.uid === cleanFleetId) {
            throw new Error(
                `robot fleet ID "${cleanFleetId}" collides with human operator "${human.identity}"`
            );
        }
    }

    const patch = {};

    if (
        !isPlainObject(existingRoleRec) ||
        existingRoleRec.role !== "robot" ||
        existingRoleRec.name !== cleanFleetId
    ) {
        patch[`assignments/${cleanRobotUid}`] = {
            role: "robot",
            name: cleanFleetId,
        };
    }

    const existingRobotRec = isPlainObject(robots[cleanFleetId])
        ? robots[cleanFleetId]
        : {};
    const previousRobotUids = new Set();
    if (
        typeof existingRobotRec.uid === "string" &&
        existingRobotRec.uid &&
        existingRobotRec.uid !== cleanRobotUid
    ) {
        previousRobotUids.add(existingRobotRec.uid);
    }
    for (const [uidKey, rec] of Object.entries(assignments)) {
        if (
            uidKey !== cleanRobotUid &&
            isPlainObject(rec) &&
            rec.role === "robot" &&
            rec.name === cleanFleetId
        ) {
            previousRobotUids.add(uidKey);
        }
    }
    for (const oldUid of previousRobotUids) {
        patch[`assignments/${oldUid}`] = null;
        if (oldUid !== cleanFleetId) {
            patch[`rooms/${oldUid}`] = null;
        }
    }

    if (existingRobotRec.uid !== cleanRobotUid) {
        patch[`robots/${cleanFleetId}/uid`] = cleanRobotUid;
    }
    if (existingRobotRec.name !== cleanFleetId) {
        patch[`robots/${cleanFleetId}/name`] = cleanFleetId;
    }

    const selectedUsers = new Set(params.selectedUserIdentities);
    for (const human of params.directory.humans) {
        if (human.identity === cleanRobotUid || human.uid === cleanRobotUid) {
            continue;
        }
        if (selectedUsers.has(human.identity)) {
            if (assignments[human.identity]?.robots?.[cleanFleetId] !== true) {
                patch[`assignments/${human.identity}/robots/${cleanFleetId}`] =
                    true;
            }
            if (
                human.uid &&
                human.uid !== human.identity &&
                assignments[human.uid]?.robots?.[cleanFleetId] !== undefined
            ) {
                patch[`assignments/${human.uid}/robots/${cleanFleetId}`] = null;
            }
        } else {
            for (const key of human.assignmentKeys) {
                if (assignments[key]?.robots?.[cleanFleetId] !== undefined) {
                    patch[`assignments/${key}/robots/${cleanFleetId}`] = null;
                }
            }
        }
    }

    const selectedMapSet = new Set(
        params.selectedMaps.map((m) => validateRtdbKey(m, "map ID"))
    );
    const existingFleetMaps = isPlainObject(assignments[cleanFleetId]?.maps)
        ? Object.keys(assignments[cleanFleetId].maps)
        : [];
    for (const m of [
        ...new Set([...existingFleetMaps, ...selectedMapSet]),
    ].sort()) {
        if (selectedMapSet.has(m)) {
            if (assignments[cleanFleetId]?.maps?.[m] !== true) {
                patch[`assignments/${cleanFleetId}/maps/${m}`] = true;
            }
        } else {
            if (assignments[cleanFleetId]?.maps?.[m] !== undefined) {
                patch[`assignments/${cleanFleetId}/maps/${m}`] = null;
            }
            appendLegacyMapRevocations(
                patch,
                params.snapshot.mapAccess,
                m,
                [cleanFleetId]
            );
        }
    }

    const selectedFlags = new Set(params.selectedFeatureFlags);
    const currentConfig = isPlainObject(existingRobotRec.config)
        ? existingRobotRec.config
        : {};
    for (const [flag, meta] of Object.entries(params.declaredFeatures)) {
        const desired = selectedFlags.has(flag);
        const stored = currentConfig[flag];
        const effective =
            typeof stored === "boolean" ? stored : Boolean(meta.enabled);
        if (desired !== effective) {
            patch[`robots/${cleanFleetId}/config/${flag}`] = desired;
        }
    }

    return assertDisjointPatchPaths(patch);
}

/**
 * Build an atomic multi-location patch removing all Realtime Database state for a decommissioned robot.
 *
 * @param {{
 *   snapshot: {
 *     assignments?: Record<string, Record<string, unknown>>,
 *     robots?: Record<string, Record<string, unknown>>
 *   },
 *   fleetId: string
 * }} params Snapshot and target fleet ID.
 * @returns {{patch: Record<string, unknown>, robotUid: string | null}} Removal patch and resolved robot Auth UID.
 */
function buildRobotDecommissionPatch(params) {
    const cleanFleetId = validateRtdbKey(params.fleetId, "robot fleet ID");
    const assignments = isPlainObject(params.snapshot.assignments)
        ? params.snapshot.assignments
        : {};
    const robots = isPlainObject(params.snapshot.robots)
        ? params.snapshot.robots
        : {};

    let robotUid =
        isPlainObject(robots[cleanFleetId]) &&
        typeof robots[cleanFleetId].uid === "string" &&
        robots[cleanFleetId].uid
            ? robots[cleanFleetId].uid
            : null;
    if (!robotUid) {
        const match = Object.entries(assignments).find(
            ([, val]) =>
                isPlainObject(val) &&
                val.role === "robot" &&
                val.name === cleanFleetId
        );
        if (match) robotUid = match[0];
    }

    const patch = {
        [`robots/${cleanFleetId}`]: null,
        [`launch_logs/${cleanFleetId}`]: null,
    };

    if (assignments[cleanFleetId] !== undefined) {
        patch[`assignments/${cleanFleetId}`] = null;
    }
    if (robotUid && robotUid !== cleanFleetId) {
        patch[`assignments/${robotUid}`] = null;
        patch[`rooms/${robotUid}`] = null;
    }

    for (const [identity, entry] of Object.entries(assignments)) {
        if (identity === cleanFleetId || identity === robotUid) continue;
        if (
            isPlainObject(entry) &&
            isPlainObject(entry.robots) &&
            entry.robots[cleanFleetId] !== undefined
        ) {
            patch[`assignments/${identity}/robots/${cleanFleetId}`] = null;
        }
    }

    if (isPlainObject(params.snapshot.mapAccess)) {
        for (const mapId of Object.keys(params.snapshot.mapAccess)) {
            appendLegacyMapRevocations(
                patch,
                params.snapshot.mapAccess,
                mapId,
                [cleanFleetId]
            );
        }
    }

    return {
        patch: assertDisjointPatchPaths(patch),
        robotUid,
    };
}

/**
 * Prompt for and confirm a password for a new Firebase Auth account.
 *
 * @param {string} email Account email being created.
 * @returns {Promise<string>} Confirmed password (at least 6 characters).
 */
async function promptConfirmedPassword(email) {
    for (;;) {
        const first = await promptPassword({
            message: `Initial password for ${email} (min 6 characters):`,
        });
        if (first.length < 6) {
            console.error("Password must be at least 6 characters.");
            continue;
        }
        const second = await promptPassword({
            message: "Confirm password:",
        });
        if (first !== second) {
            console.error("Passwords did not match. Try again.");
            continue;
        }
        return first;
    }
}

/**
 * Resolve an Auth account by email, or collect credentials for deferred creation after confirmation.
 *
 * @param {{
 *   email: string,
 *   authUsers: {uid: string, email: string}[],
 *   dryRun: boolean
 * }} ctx Lookup and creation context.
 * @returns {Promise<{uid: string, email: string, created: boolean, pendingPassword: string | null} | null>} Resolved or pending account, or null if cancelled.
 */
async function resolveOrCreateAuthAccount(ctx) {
    const cleanEmail = ctx.email.trim();
    const existing = ctx.authUsers.find(
        (u) => u.email.toLowerCase() === cleanEmail.toLowerCase()
    );
    if (existing) {
        return {
            uid: existing.uid,
            email: existing.email,
            created: false,
            pendingPassword: null,
        };
    }

    const shouldCreate = await confirm({
        message: `No Firebase Auth account exists for "${cleanEmail}". Create Email/Password account now?`,
        default: true,
    });
    if (!shouldCreate) {
        return null;
    }

    const safePlaceholder = `${ctx.dryRun ? "dryrun" : "pending"}-uid-${cleanEmail.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    if (ctx.dryRun) {
        console.log(
            `[dry-run] Skipping Auth user creation; previewing RTDB paths with placeholder UID "${safePlaceholder}".`
        );
        return {
            uid: safePlaceholder,
            email: cleanEmail,
            created: true,
            pendingPassword: null,
        };
    }

    const pw = await promptConfirmedPassword(cleanEmail);
    return {
        uid: safePlaceholder,
        email: cleanEmail,
        created: true,
        pendingPassword: pw,
    };
}

/**
 * Create a deferred Firebase Auth account and apply the patch, rolling back the Auth user if the DB write fails.
 *
 * @param {{
 *   projectId: string,
 *   apiKey: string,
 *   clients: {authClient: import("firebase-tools/lib/apiv2").Client, dbClient: import("firebase-tools/lib/apiv2").Client}
 * }} ctx Runtime context.
 * @param {{uid: string, email: string, created: boolean, pendingPassword: string | null} | null} account Pending or existing account.
 * @param {(resolvedUid: string) => Record<string, unknown>} buildPatch Patch builder accepting the final Auth UID.
 * @returns {Promise<void>}
 */
async function commitPendingAuthAndPatch(ctx, account, buildPatch) {
    let resolvedUid = account ? account.uid : null;
    let createdUid = null;
    if (account && account.pendingPassword) {
        const created = await createAuthUser(
            ctx.projectId,
            account.email,
            account.pendingPassword,
            {
                authClient: ctx.clients.authClient,
                apiKey: ctx.apiKey,
            }
        );
        resolvedUid = created.uid;
        createdUid = created.uid;
        console.log(
            `Created Firebase Auth user ${created.email} (${created.uid}).`
        );
    }

    const finalPatch = buildPatch(resolvedUid);
    try {
        await applyRootPatch(ctx.clients.dbClient, finalPatch);
    } catch (err) {
        if (createdUid) {
            try {
                await deleteAuthUser(
                    ctx.projectId,
                    createdUid,
                    ctx.clients.authClient
                );
                console.error(
                    `Rolled back newly created Auth account ${createdUid} after database write failure.`
                );
            } catch (rollbackErr) {
                console.error(
                    `WARNING: Failed to roll back Auth account ${createdUid}: ${rollbackErr.message}`
                );
            }
        }
        throw err;
    }
}

/**
 * Run the interactive user permissions workflow.
 *
 * @param {{
 *   projectId: string,
 *   apiKey: string,
 *   clients: {authClient: import("firebase-tools/lib/apiv2").Client, dbClient: import("firebase-tools/lib/apiv2").Client},
 *   snapshot: Awaited<ReturnType<typeof fetchAdminSnapshot>>,
 *   directory: ReturnType<typeof classifyDirectory>,
 *   dryRun: boolean
 * }} ctx Runtime context.
 * @returns {Promise<void>}
 */
async function runUserWorkflow(ctx) {
    const { directory, snapshot } = ctx;

    const choices = [
        { name: "+ Add new user", value: ADD_NEW_SENTINEL },
        ...directory.humans.map((h) => {
            const label = h.email
                ? h.alias
                    ? `${h.email} (alias: ${h.alias})`
                    : `${h.email} (uid: ${h.uid})`
                : `${h.identity} (standalone assignment)`;
            const counts = `${h.assignedRobots.length} robot(s), ${h.assignedMaps.length} map(s)`;
            const splitWarn = h.hasSplitAssignments ? " [split uid/alias]" : "";
            return {
                name: `${label} — ${counts}${splitWarn}`,
                value: h.identity,
            };
        }),
    ];

    const picked = await select({
        message: "Select a user to configure, or add a new user:",
        choices,
    });

    let targetHuman;
    let pendingAccount = null;
    if (picked === ADD_NEW_SENTINEL) {
        const rawEmail = await input({
            message: "User email address:",
            validate: (v) =>
                v && v.trim().includes("@")
                    ? true
                    : "Enter a valid email address",
        });
        pendingAccount = await resolveOrCreateAuthAccount({
            email: rawEmail,
            authUsers: snapshot.authUsers,
            dryRun: ctx.dryRun,
        });
        if (!pendingAccount) {
            console.log("Aborted.");
            return;
        }
        targetHuman = directory.humans.find((h) => h.uid === pendingAccount.uid) || {
            uid: pendingAccount.uid,
            email: pendingAccount.email,
            alias: null,
            identity: pendingAccount.uid,
            assignmentKeys: [pendingAccount.uid],
            assignedRobots: [],
            assignedMaps: [],
            hasSplitAssignments: false,
        };
    } else {
        targetHuman = directory.humans.find((h) => h.identity === picked);
    }

    if (!targetHuman) {
        throw new Error("selected user not found");
    }

    let targetAlias = targetHuman.alias;
    if (targetHuman.uid) {
        const rawAlias = await input({
            message: `Optional alias for ${targetHuman.email || targetHuman.uid} (leave blank to use Auth UID "${targetHuman.uid}"):`,
            default: targetHuman.alias || "",
            validate: (val) => {
                if (!val || !val.trim()) return true;
                try {
                    validateHumanAlias(val, targetHuman.uid, snapshot);
                    return true;
                } catch (err) {
                    return err.message;
                }
            },
        });
        targetAlias = rawAlias.trim() || null;
    }

    let selectedRobots = [];
    if (directory.robots.length > 0) {
        selectedRobots = await checkbox({
            message: `Check robots accessible to ${targetHuman.email || targetHuman.identity}:`,
            choices: directory.robots.map((r) => ({
                name: `${r.fleetId} (${r.status}${r.buildDescribe ? `, ${r.buildDescribe}` : ""})`,
                value: r.fleetId,
                checked: targetHuman.assignedRobots.includes(r.fleetId),
            })),
        });
    } else {
        console.log("No robots are currently registered in Realtime Database.");
    }

    let selectedMaps = [...targetHuman.assignedMaps];
    if (directory.mapIds.length > 0) {
        selectedMaps = await checkbox({
            message: `Check maps accessible to ${targetHuman.email || targetHuman.identity}:`,
            choices: directory.mapIds.map((m) => {
                const source = directory.cloudMapIds.includes(m)
                    ? "cloud"
                    : "robot-local";
                return {
                    name: `${m} (${source})`,
                    value: m,
                    checked: targetHuman.assignedMaps.includes(m),
                };
            }),
        });
    }

    const extraLocalMaps = await input({
        message:
            "Additional robot-local map IDs to grant (comma-separated stems, or leave blank):",
        default: "",
        validate: validateExtraLocalMaps,
    });
    if (extraLocalMaps.trim()) {
        const extras = extraLocalMaps
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        selectedMaps = [...new Set([...selectedMaps, ...extras])];
    }

    const revokedCloudMaps = targetHuman.assignedMaps.filter(
        (m) =>
            !selectedMaps.includes(m) && directory.cloudMapIds.includes(m)
    );
    const snapshotWithMapAccess =
        revokedCloudMaps.length > 0
            ? {
                  ...snapshot,
                  mapAccess: await fetchMapAccessMetadata(
                      ctx.clients.dbClient,
                      revokedCloudMaps
                  ),
              }
            : snapshot;

    const buildPatchForUid = (resolvedUid) =>
        buildUserPermissionsPatch({
            snapshot: snapshotWithMapAccess,
            uid: resolvedUid,
            currentAlias: targetHuman.alias,
            targetAlias,
            selectedRobots,
            selectedMaps,
        });

    const previewPatch = buildPatchForUid(targetHuman.uid);

    if (Object.keys(previewPatch).length === 0 && !pendingAccount?.pendingPassword) {
        console.log("No permission changes needed.");
        return;
    }

    printPatchPreview(previewPatch, ctx.projectId);
    if (ctx.dryRun) {
        console.log("Dry run complete; no changes were written.");
        return;
    }

    const ok = await confirm({
        message: `Apply these changes to "${ctx.projectId}"?`,
        default: false,
    });
    if (!ok) {
        console.log("Aborted; nothing was written.");
        return;
    }

    await commitPendingAuthAndPatch(
        ctx,
        pendingAccount,
        (resolvedUid) =>
            buildPatchForUid(
                pendingAccount?.pendingPassword ? resolvedUid : targetHuman.uid
            )
    );
    console.log("User permissions updated.");
}

/**
 * Run the interactive robot onboarding, editing, or decommissioning workflow.
 *
 * @param {{
 *   projectId: string,
 *   apiKey: string,
 *   clients: {authClient: import("firebase-tools/lib/apiv2").Client, dbClient: import("firebase-tools/lib/apiv2").Client},
 *   snapshot: Awaited<ReturnType<typeof fetchAdminSnapshot>>,
 *   directory: ReturnType<typeof classifyDirectory>,
 *   dryRun: boolean
 * }} ctx Runtime context.
 * @returns {Promise<void>}
 */
async function runRobotWorkflow(ctx) {
    const { directory, snapshot } = ctx;
    const declaredFeatures = loadDeclaredFeatures();

    const choices = [
        { name: "+ Add new robot", value: ADD_NEW_SENTINEL },
        ...directory.robots.map((r) => {
            const health = r.bindingConsistent ? "" : " [binding mismatch]";
            const info = `${r.status}${r.buildDescribe ? `, ${r.buildDescribe}` : ""}`;
            return {
                name: `${r.fleetId} (${info})${health}`,
                value: r.fleetId,
            };
        }),
    ];

    const picked = await select({
        message: "Select a robot to configure, or add a new robot:",
        choices,
    });

    let fleetId;
    let robotUid;
    let pendingAccount = null;
    let existingRobot = null;

    if (picked === ADD_NEW_SENTINEL) {
        fleetId = await input({
            message: "Robot fleet ID (e.g. stretch-se4-4001):",
            validate: (v) => {
                try {
                    validateRtdbKey(v, "robot fleet ID");
                    return true;
                } catch (err) {
                    return err.message;
                }
            },
        });
        fleetId = fleetId.trim();
        existingRobot =
            directory.robots.find((r) => r.fleetId === fleetId) || null;

        const defaultEmail = existingRobot?.email || `${fleetId}@example.com`;
        const robotEmail = await input({
            message: `Machine Auth email for ${fleetId}:`,
            default: defaultEmail,
            validate: (v) =>
                v && v.trim().includes("@")
                    ? true
                    : "Enter a valid email address",
        });

        pendingAccount = await resolveOrCreateAuthAccount({
            email: robotEmail,
            authUsers: snapshot.authUsers,
            dryRun: ctx.dryRun,
        });
        if (!pendingAccount) {
            console.log("Aborted.");
            return;
        }
        robotUid = pendingAccount.uid;
    } else {
        existingRobot = directory.robots.find((r) => r.fleetId === picked);
        if (!existingRobot) {
            throw new Error(`robot "${picked}" not found`);
        }
        fleetId = existingRobot.fleetId;

        const action = await select({
            message: `Action for ${fleetId}:`,
            choices: [
                {
                    name: "Edit assigned users, cloud maps, and feature flags",
                    value: "edit",
                },
                {
                    name: "Decommission / remove robot from Realtime Database",
                    value: "decommission",
                },
            ],
        });

        if (action === "decommission") {
            const decommSnapshot =
                directory.cloudMapIds.length > 0
                    ? {
                          ...snapshot,
                          mapAccess: await fetchMapAccessMetadata(
                              ctx.clients.dbClient,
                              directory.cloudMapIds
                          ),
                      }
                    : snapshot;
            const { patch, robotUid: resolvedUid } =
                buildRobotDecommissionPatch({
                    snapshot: decommSnapshot,
                    fleetId,
                });
            printPatchPreview(patch, ctx.projectId);
            if (ctx.dryRun) {
                console.log("Dry run complete; no changes were written.");
                return;
            }
            const ok = await confirm({
                message: `Permanently remove "${fleetId}" and all its grants from "${ctx.projectId}"?`,
                default: false,
            });
            if (!ok) {
                console.log("Aborted; nothing was written.");
                return;
            }
            await applyRootPatch(ctx.clients.dbClient, patch);
            console.log(`Removed Realtime Database records for ${fleetId}.`);

            if (resolvedUid) {
                const delAuth = await confirm({
                    message: `Also delete machine Auth user ${existingRobot.email || resolvedUid} (${resolvedUid})?`,
                    default: false,
                });
                if (delAuth) {
                    await deleteAuthUser(
                        ctx.projectId,
                        resolvedUid,
                        ctx.clients.authClient
                    );
                    console.log(
                        `Deleted Firebase Auth account ${resolvedUid}.`
                    );
                }
            }
            return;
        }

        robotUid = existingRobot.uid;
        if (!robotUid) {
            const robotEmail = await input({
                message: `${fleetId} has no bound Auth UID. Enter its machine Auth email:`,
                validate: (v) =>
                    v && v.trim().includes("@")
                        ? true
                        : "Enter a valid email address",
            });
            pendingAccount = await resolveOrCreateAuthAccount({
                email: robotEmail,
                authUsers: snapshot.authUsers,
                dryRun: ctx.dryRun,
            });
            if (!pendingAccount) {
                console.log("Aborted.");
                return;
            }
            robotUid = pendingAccount.uid;
        }
    }

    let selectedUsers = [];
    if (directory.humans.length > 0) {
        selectedUsers = await checkbox({
            message: `Check operators permitted to access ${fleetId}:`,
            choices: directory.humans.map((h) => ({
                name: h.email ? `${h.email} (${h.identity})` : h.identity,
                value: h.identity,
                checked: h.assignedRobots.includes(fleetId),
            })),
        });
    } else {
        console.log("No human operator accounts exist yet.");
    }

    let selectedMaps = existingRobot ? [...existingRobot.assignedMaps] : [];
    if (directory.cloudMapIds.length > 0) {
        selectedMaps = await checkbox({
            message: `Check cloud maps ${fleetId} is permitted to download:`,
            choices: directory.cloudMapIds.map((m) => ({
                name: m,
                value: m,
                checked: Boolean(existingRobot?.assignedMaps.includes(m)),
            })),
        });
    }

    const flagNames = Object.keys(declaredFeatures);
    let selectedFlags = [];
    if (flagNames.length > 0) {
        selectedFlags = await checkbox({
            message: `Check enabled feature flags for ${fleetId}:`,
            choices: flagNames.map((flag) => {
                const stored = existingRobot?.config?.[flag];
                const checked =
                    typeof stored === "boolean"
                        ? stored
                        : declaredFeatures[flag].enabled;
                return {
                    name: `${flag} (default: ${declaredFeatures[flag].enabled ? "on" : "off"})`,
                    value: flag,
                    checked,
                };
            }),
        });
    }

    const revokedCloudMaps = (existingRobot?.assignedMaps || []).filter(
        (m) =>
            !selectedMaps.includes(m) && directory.cloudMapIds.includes(m)
    );
    const snapshotWithMapAccess =
        revokedCloudMaps.length > 0
            ? {
                  ...snapshot,
                  mapAccess: await fetchMapAccessMetadata(
                      ctx.clients.dbClient,
                      revokedCloudMaps
                  ),
              }
            : snapshot;

    const buildPatchForUid = (resolvedUid) =>
        buildRobotPermissionsPatch({
            snapshot: snapshotWithMapAccess,
            directory,
            fleetId,
            robotUid: resolvedUid,
            selectedUserIdentities: selectedUsers,
            selectedMaps,
            selectedFeatureFlags: selectedFlags,
            declaredFeatures,
        });

    const previewPatch = buildPatchForUid(robotUid);

    if (Object.keys(previewPatch).length === 0 && !pendingAccount?.pendingPassword) {
        console.log("No robot permission or config changes needed.");
        return;
    }

    printPatchPreview(previewPatch, ctx.projectId);
    if (ctx.dryRun) {
        console.log("Dry run complete; no changes were written.");
        return;
    }

    const ok = await confirm({
        message: `Apply these changes to "${ctx.projectId}"?`,
        default: false,
    });
    if (!ok) {
        console.log("Aborted; nothing was written.");
        return;
    }

    await commitPendingAuthAndPatch(
        ctx,
        pendingAccount,
        (resolvedUid) =>
            buildPatchForUid(
                pendingAccount?.pendingPassword ? resolvedUid : robotUid
            )
    );
    console.log(`Updated robot "${fleetId}".`);
}

/**
 * Entrypoint for `npm run firebase:permissions`.
 *
 * @returns {Promise<void>}
 */
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(USAGE);
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            "firebase:permissions requires an interactive terminal (TTY)"
        );
    }

    const { projectId, databaseOrigin, apiKey } = readFirebaseEnv();
    const actor = await authenticateAdmin(projectId);
    console.log(`Authenticated to "${projectId}" as ${actor}.`);

    const clients = createAdminClients(databaseOrigin);
    const snapshot = await fetchAdminSnapshot(projectId, clients);
    const directory = classifyDirectory(snapshot);

    let mode = opts.mode;
    if (mode === "menu") {
        mode = await select({
            message: "What would you like to manage?",
            choices: [
                {
                    name: `Users (${directory.humans.length} operator account${directory.humans.length === 1 ? "" : "s"})`,
                    value: "user",
                },
                {
                    name: `Robots (${directory.robots.length} fleet robot${directory.robots.length === 1 ? "" : "s"})`,
                    value: "robot",
                },
            ],
        });
    }

    const ctx = {
        projectId,
        apiKey,
        clients,
        snapshot,
        directory,
        dryRun: opts.dryRun,
    };

    if (mode === "user") {
        await runUserWorkflow(ctx);
    } else {
        await runRobotWorkflow(ctx);
    }
}

module.exports = {
    buildRobotDecommissionPatch,
    buildRobotPermissionsPatch,
    buildUserPermissionsPatch,
    loadDeclaredFeatures,
    parseArgs,
    validateExtraLocalMaps,
    validateHumanAlias,
};

if (require.main === module) {
    main().catch((err) => {
        if (err && err.name === "ExitPromptError") {
            console.error("\nCancelled.");
            process.exit(130);
        }
        console.error(`ERROR: ${err.message}`);
        if (err.cause?.message) {
            console.error(`  Cause: ${err.cause.message}`);
        }
        process.exit(1);
    });
}
