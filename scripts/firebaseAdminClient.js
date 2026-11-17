#!/usr/bin/env node

/**
 * Shared Firebase Authentication, Realtime Database, and state-classification
 * helpers for interactive administrative CLI scripts.
 */

const path = require("node:path");

const dotenv = require("dotenv");
const { identityOrigin } = require("firebase-tools/lib/api");
const { Client } = require("firebase-tools/lib/apiv2");
const { selectAccount, setActiveAccount } = require("firebase-tools/lib/auth");
const {
    getFirebaseProject,
} = require("firebase-tools/lib/management/projects");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const { syncFirebaseRc } = require("./syncFirebaseRc");

const defaultRepoRoot = path.join(__dirname, "..");

/** Punctuation characters forbidden inside a single Firebase Realtime Database key. */
const INVALID_RTDB_KEY = /[.$#[\]/]/;

/** Minimum password length enforced by Firebase Email/Password Authentication. */
const MIN_PASSWORD_LENGTH = 6;

/** Maximum accounts requested per Identity Toolkit batchGet page. */
const AUTH_PAGE_SIZE = 1000;

/**
 * Read Firebase project and database connection settings from `.env` or `process.env`.
 *
 * @param {string} [root] Repository root containing `.env`.
 * @returns {{projectId: string, databaseOrigin: string, apiKey: string}} Resolved configuration.
 * @throws {Error} When `PUBLIC_FIREBASE_PROJECT_ID` or `PUBLIC_FIREBASE_DATABASE_URL` is missing or invalid.
 */
function readFirebaseEnv(root = defaultRepoRoot) {
    const parsed =
        dotenv.config({ path: path.join(root, ".env") }).parsed || {};
    const projectId = (
        parsed.PUBLIC_FIREBASE_PROJECT_ID ||
        process.env.PUBLIC_FIREBASE_PROJECT_ID ||
        ""
    ).trim();
    const rawDbUrl = (
        parsed.PUBLIC_FIREBASE_DATABASE_URL ||
        process.env.PUBLIC_FIREBASE_DATABASE_URL ||
        ""
    ).trim();
    const apiKey = (
        parsed.PUBLIC_FIREBASE_API_KEY ||
        process.env.PUBLIC_FIREBASE_API_KEY ||
        ""
    ).trim();

    if (!projectId) {
        throw new Error(
            "PUBLIC_FIREBASE_PROJECT_ID is not set in .env or environment"
        );
    }
    if (!rawDbUrl) {
        throw new Error(
            "PUBLIC_FIREBASE_DATABASE_URL is not set in .env or environment"
        );
    }

    let databaseOrigin;
    try {
        databaseOrigin = new URL(rawDbUrl).origin;
    } catch (err) {
        throw new Error(
            `PUBLIC_FIREBASE_DATABASE_URL is not a valid URL: ${rawDbUrl}`,
            { cause: err }
        );
    }

    return { projectId, databaseOrigin, apiKey };
}

/**
 * Check whether `text` contains ASCII control characters (0x00-0x1F or 0x7F).
 *
 * @param {string} text Input string.
 * @returns {boolean} True when any ASCII control character is present.
 */
function hasAsciiControlChar(text) {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/**
 * Validate a single Realtime Database path segment.
 *
 * @param {string} key Candidate key segment.
 * @param {string} [label] Human-readable field name for error messages.
 * @returns {string} Trimmed key segment.
 * @throws {Error} When the key is empty or contains characters rejected by Realtime Database.
 */
function validateRtdbKey(key, label = "identifier") {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) {
        throw new Error(`${label} must not be empty`);
    }
    if (INVALID_RTDB_KEY.test(trimmed) || hasAsciiControlChar(trimmed)) {
        throw new Error(
            `${label} "${trimmed}" contains characters forbidden in Realtime Database keys (. $ # [ ] /)`
        );
    }
    return trimmed;
}

/**
 * Normalize a relative Realtime Database path and validate each segment.
 *
 * @param {string} rawPath Slash-delimited database path.
 * @returns {string} Normalized path with no leading or trailing slash.
 * @throws {Error} When the path is empty or contains an invalid key segment.
 */
function normalizePatchPath(rawPath) {
    if (typeof rawPath !== "string") {
        throw new Error("patch path must be a string");
    }
    const trimmed = rawPath.replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
        throw new Error("patch path must not target the database root");
    }
    const segments = trimmed.split("/");
    for (const seg of segments) {
        validateRtdbKey(seg, `path segment in "${rawPath}"`);
    }
    return segments.join("/");
}

/**
 * Verify that no two keys in a multi-location `PATCH` payload overlap as ancestor and descendant.
 *
 * Realtime Database rejects a multi-path `PATCH` when one path is a prefix of another.
 *
 * @param {Record<string, unknown>} patch Candidate multi-location patch object.
 * @returns {Record<string, unknown>} Copy of `patch` keyed by normalized paths.
 * @throws {Error} When paths are empty, duplicate after normalization, or ancestor/descendant overlapping.
 */
function assertDisjointPatchPaths(patch) {
    const normalized = {};
    const paths = [];
    for (const [rawKey, value] of Object.entries(patch)) {
        const clean = normalizePatchPath(rawKey);
        if (Object.prototype.hasOwnProperty.call(normalized, clean)) {
            throw new Error(`duplicate patch path "${clean}"`);
        }
        normalized[clean] = value;
        paths.push(clean);
    }
    paths.sort();
    for (let i = 1; i < paths.length; i++) {
        const prev = paths[i - 1];
        const curr = paths[i];
        if (curr.startsWith(`${prev}/`)) {
            throw new Error(
                `overlapping patch paths "${prev}" and "${curr}" cannot be sent in one multi-location update`
            );
        }
    }
    return normalized;
}

/**
 * Sync `.firebaserc` and verify active Firebase CLI or ADC credentials against `projectId`.
 *
 * @param {string} projectId Target Firebase project ID.
 * @param {string} [root] Repository root containing `.firebaserc`.
 * @returns {Promise<string>} Authenticated account identifier.
 * @throws {Error} When no valid Firebase credentials are available for `projectId`.
 */
async function authenticateAdmin(projectId, root = defaultRepoRoot) {
    syncFirebaseRc(projectId, path.join(root, ".firebaserc"));
    const options = {};
    const account = selectAccount(undefined, root);
    if (account) {
        setActiveAccount(options, account);
    }
    try {
        const email = await requireAuth(options);
        await getFirebaseProject(projectId);
        return email ?? account?.user?.email ?? "service account";
    } catch (err) {
        throw new Error(
            `not authenticated to Firebase project "${projectId}". Run "npm run firebase:login" or set GOOGLE_APPLICATION_CREDENTIALS.`,
            { cause: err }
        );
    }
}

/**
 * Build authenticated REST clients for Identity Toolkit and Realtime Database.
 *
 * @param {string} databaseOrigin Origin URL of the Realtime Database instance.
 * @returns {{authClient: Client, dbClient: Client}} Authenticated REST clients.
 */
function createAdminClients(databaseOrigin) {
    return {
        authClient: new Client({ urlPrefix: identityOrigin(), auth: true }),
        dbClient: new Client({ urlPrefix: databaseOrigin, auth: true }),
    };
}

/**
 * List all Firebase Authentication accounts in `projectId`.
 *
 * @param {string} projectId Firebase project ID.
 * @param {Client} authClient Authenticated Identity Toolkit client.
 * @returns {Promise<{uid: string, email: string, displayName: string, disabled: boolean}[]>} Project accounts.
 * @throws {Error} When the Identity Toolkit request fails.
 */
async function listAuthUsers(projectId, authClient) {
    const users = [];
    let nextPageToken = "";
    do {
        const queryParams = { maxResults: String(AUTH_PAGE_SIZE) };
        if (nextPageToken) {
            queryParams.nextPageToken = nextPageToken;
        }
        let res;
        try {
            res = await authClient.request({
                method: "GET",
                path: `/v1/projects/${encodeURIComponent(projectId)}/accounts:batchGet`,
                queryParams,
                skipLog: { resBody: true },
            });
        } catch (err) {
            throw new Error(
                `failed to list Firebase Authentication users for "${projectId}"`,
                { cause: err }
            );
        }
        const batch = Array.isArray(res.body?.users) ? res.body.users : [];
        for (const entry of batch) {
            if (entry && typeof entry.localId === "string" && entry.localId) {
                users.push({
                    uid: entry.localId,
                    email: typeof entry.email === "string" ? entry.email : "",
                    displayName:
                        typeof entry.displayName === "string"
                            ? entry.displayName
                            : "",
                    disabled: Boolean(entry.disabled),
                });
            }
        }
        nextPageToken =
            typeof res.body?.nextPageToken === "string"
                ? res.body.nextPageToken
                : "";
    } while (nextPageToken);

    return users;
}

/**
 * Create an Email/Password account in Firebase Authentication.
 *
 * @param {string} projectId Firebase project ID.
 * @param {string} email Account email address.
 * @param {string} password Initial password (at least 6 characters).
 * @param {{authClient: Client, apiKey?: string}} deps Authenticated Identity Toolkit client and optional web API key.
 * @returns {Promise<{uid: string, email: string}>} Newly created Auth UID and email.
 * @throws {Error} When validation fails or Identity Toolkit rejects account creation.
 */
async function createAuthUser(projectId, email, password, deps) {
    const cleanEmail = typeof email === "string" ? email.trim() : "";
    if (!cleanEmail || !cleanEmail.includes("@")) {
        throw new Error(`invalid email address "${email}"`);
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(
            `password must be at least ${MIN_PASSWORD_LENGTH} characters`
        );
    }

    const queryParams = deps.apiKey ? { key: deps.apiKey } : {};
    try {
        const res = await deps.authClient.request({
            method: "POST",
            path: `/v1/projects/${encodeURIComponent(projectId)}/accounts`,
            queryParams,
            body: { email: cleanEmail, password },
            skipLog: { reqBody: true, resBody: true },
        });
        const uid = res.body?.localId;
        if (typeof uid !== "string" || !uid) {
            throw new Error(
                "Identity Toolkit did not return a localId for the new user"
            );
        }
        return { uid, email: res.body?.email || cleanEmail };
    } catch (err) {
        throw new Error(`failed to create Auth account for "${cleanEmail}"`, {
            cause: err,
        });
    }
}

/**
 * Delete an account from Firebase Authentication by UID.
 *
 * @param {string} projectId Firebase project ID.
 * @param {string} uid Firebase Auth `localId` to delete.
 * @param {Client} authClient Authenticated Identity Toolkit client.
 * @returns {Promise<void>}
 * @throws {Error} When `uid` is empty or deletion fails.
 */
async function deleteAuthUser(projectId, uid, authClient) {
    const cleanUid = typeof uid === "string" ? uid.trim() : "";
    if (!cleanUid) {
        throw new Error("Auth uid must not be empty");
    }
    try {
        await authClient.request({
            method: "POST",
            path: `/v1/projects/${encodeURIComponent(projectId)}/accounts:delete`,
            body: { localId: cleanUid },
        });
    } catch (err) {
        throw new Error(`failed to delete Auth account "${cleanUid}"`, {
            cause: err,
        });
    }
}

/**
 * Read a JSON value at `dbPath` from Realtime Database.
 *
 * @param {Client} dbClient Authenticated Realtime Database client.
 * @param {string} dbPath Slash-prefixed database path (without `.json`).
 * @param {Record<string, string>} [queryParams] Optional query parameters (e.g. `{ shallow: "true" }`).
 * @returns {Promise<unknown>} Parsed JSON value at `dbPath`, or `null` when absent.
 * @throws {Error} When the database request fails.
 */
async function readDbPath(dbClient, dbPath, queryParams = {}) {
    const clean = dbPath.replace(/^\/+|\/+$/g, "");
    const jsonPath = clean ? `/${clean}.json` : "/.json";
    try {
        const res = await dbClient.request({
            method: "GET",
            path: jsonPath,
            queryParams,
            skipLog: { resBody: true },
        });
        return res.body ?? null;
    } catch (err) {
        throw new Error(`failed to read Realtime Database path "/${clean}"`, {
            cause: err,
        });
    }
}

/**
 * Fetch the Authentication user list and Realtime Database permission trees concurrently.
 *
 * `/maps` is queried with `shallow=true` so base64 map images are not downloaded when listing map IDs.
 *
 * @param {string} projectId Firebase project ID.
 * @param {{authClient: Client, dbClient: Client}} clients Authenticated REST clients.
 * @returns {Promise<{
 *   authUsers: {uid: string, email: string, displayName: string, disabled: boolean}[],
 *   uids: Record<string, string>,
 *   assignments: Record<string, Record<string, unknown>>,
 *   robots: Record<string, Record<string, unknown>>,
 *   mapKeys: Record<string, boolean>
 * }>} Snapshot of accounts and permission paths.
 */
async function fetchAdminSnapshot(projectId, clients) {
    const [authUsers, uidsRaw, assignmentsRaw, robotsRaw, mapsShallow] =
        await Promise.all([
            listAuthUsers(projectId, clients.authClient),
            readDbPath(clients.dbClient, "/uids"),
            readDbPath(clients.dbClient, "/assignments"),
            readDbPath(clients.dbClient, "/robots"),
            readDbPath(clients.dbClient, "/maps", { shallow: "true" }),
        ]);

    return {
        authUsers,
        uids: isPlainObject(uidsRaw) ? uidsRaw : {},
        assignments: isPlainObject(assignmentsRaw) ? assignmentsRaw : {},
        robots: isPlainObject(robotsRaw) ? robotsRaw : {},
        mapKeys: isPlainObject(mapsShallow) ? mapsShallow : {},
    };
}

/**
 * Check whether `value` is a non-null, non-array object.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} True when `value` is a plain object.
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect keys mapped to boolean `true` in a grant map.
 *
 * @param {unknown} record Candidate `{ [id]: true }` object from `assignments`.
 * @returns {string[]} Sorted list of keys whose value is `true`.
 */
function trueKeys(record) {
    if (!isPlainObject(record)) return [];
    return Object.entries(record)
        .filter(([, val]) => val === true)
        .map(([key]) => key)
        .sort();
}

/**
 * Classify a raw project snapshot into human operators, robot fleet records, and known map IDs.
 *
 * Machine accounts (`assignments/<uid>.role === "robot"` or `robots/<fleetId>.uid === <uid>`)
 * are separated from human accounts so robot logins do not appear in operator lists.
 *
 * @param {{
 *   authUsers?: {uid: string, email: string, displayName?: string, disabled?: boolean}[],
 *   uids?: Record<string, string>,
 *   assignments?: Record<string, Record<string, unknown>>,
 *   robots?: Record<string, Record<string, unknown>>,
 *   mapKeys?: Record<string, unknown>
 * }} snapshot Project Auth and RTDB snapshot.
 * @returns {{
 *   humans: {
 *     uid: string | null,
 *     email: string | null,
 *     alias: string | null,
 *     identity: string,
 *     assignmentKeys: string[],
 *     assignedRobots: string[],
 *     assignedMaps: string[],
 *     hasSplitAssignments: boolean
 *   }[],
 *   robots: {
 *     fleetId: string,
 *     uid: string | null,
 *     email: string | null,
 *     status: string,
 *     buildDescribe: string | null,
 *     config: Record<string, boolean>,
 *     assignedMaps: string[],
 *     bindingConsistent: boolean
 *   }[],
 *   mapIds: string[],
 *   cloudMapIds: string[]
 * }} Classified directory of humans, robots, and maps.
 */
function classifyDirectory(snapshot) {
    const authUsers = Array.isArray(snapshot.authUsers)
        ? snapshot.authUsers
        : [];
    const uids = isPlainObject(snapshot.uids) ? snapshot.uids : {};
    const assignments = isPlainObject(snapshot.assignments)
        ? snapshot.assignments
        : {};
    const robotsObj = isPlainObject(snapshot.robots) ? snapshot.robots : {};
    const mapKeys = isPlainObject(snapshot.mapKeys) ? snapshot.mapKeys : {};

    const authByUid = new Map(authUsers.map((u) => [u.uid, u]));
    const robotUids = new Set();
    const fleetIds = new Set(Object.keys(robotsObj));

    for (const [, robotRec] of Object.entries(robotsObj)) {
        if (
            isPlainObject(robotRec) &&
            typeof robotRec.uid === "string" &&
            robotRec.uid
        ) {
            robotUids.add(robotRec.uid);
        }
    }
    for (const [key, assignRec] of Object.entries(assignments)) {
        if (isPlainObject(assignRec) && assignRec.role === "robot") {
            robotUids.add(key);
            if (typeof assignRec.name === "string" && assignRec.name) {
                fleetIds.add(assignRec.name);
            }
        }
    }

    const robots = [...fleetIds].sort().map((fleetId) => {
        const rec = isPlainObject(robotsObj[fleetId]) ? robotsObj[fleetId] : {};
        let uid = typeof rec.uid === "string" && rec.uid ? rec.uid : null;
        if (!uid) {
            const match = Object.entries(assignments).find(
                ([, val]) =>
                    isPlainObject(val) &&
                    val.role === "robot" &&
                    val.name === fleetId
            );
            if (match) uid = match[0];
        }
        const authUser = uid ? authByUid.get(uid) : null;
        const roleRec =
            uid && isPlainObject(assignments[uid]) ? assignments[uid] : null;
        const bindingConsistent = Boolean(
            uid &&
                rec.uid === uid &&
                roleRec &&
                roleRec.role === "robot" &&
                roleRec.name === fleetId
        );
        const rawConfig = isPlainObject(rec.config) ? rec.config : {};
        const config = {};
        for (const [flag, enabled] of Object.entries(rawConfig)) {
            if (typeof enabled === "boolean") {
                config[flag] = enabled;
            }
        }
        const fleetAssign = isPlainObject(assignments[fleetId])
            ? assignments[fleetId]
            : {};

        return {
            fleetId,
            uid,
            email: authUser?.email || null,
            status:
                typeof rec.status === "string" && rec.status
                    ? rec.status
                    : "offline",
            buildDescribe:
                isPlainObject(rec.build) &&
                typeof rec.build.describe === "string"
                    ? rec.build.describe
                    : null,
            config,
            assignedMaps: trueKeys(fleetAssign.maps),
            bindingConsistent,
        };
    });

    const coveredIdentities = new Set();
    const humans = [];

    for (const user of authUsers) {
        if (robotUids.has(user.uid)) continue;
        const rawAlias = uids[user.uid];
        const alias =
            typeof rawAlias === "string" && rawAlias.trim()
                ? rawAlias.trim()
                : null;
        const identity = alias || user.uid;
        const assignmentKeys =
            alias && alias !== user.uid ? [alias, user.uid] : [user.uid];

        for (const k of assignmentKeys) coveredIdentities.add(k);

        const robotSet = new Set();
        const mapSet = new Set();
        for (const k of assignmentKeys) {
            const entry = assignments[k];
            if (!isPlainObject(entry)) continue;
            for (const r of trueKeys(entry.robots)) robotSet.add(r);
            for (const m of trueKeys(entry.maps)) mapSet.add(m);
        }

        const hasSplitAssignments = Boolean(
            alias &&
                alias !== user.uid &&
                isPlainObject(assignments[user.uid]) &&
                (Object.keys(assignments[user.uid].robots || {}).length > 0 ||
                    Object.keys(assignments[user.uid].maps || {}).length > 0)
        );

        humans.push({
            uid: user.uid,
            email: user.email || null,
            alias,
            identity,
            assignmentKeys,
            assignedRobots: [...robotSet].sort(),
            assignedMaps: [...mapSet].sort(),
            hasSplitAssignments,
        });
    }

    // Include standalone assignment identities (such as pre-staged aliases with no Auth user yet).
    for (const [key, entry] of Object.entries(assignments)) {
        if (
            coveredIdentities.has(key) ||
            robotUids.has(key) ||
            fleetIds.has(key)
        ) {
            continue;
        }
        if (!isPlainObject(entry) || entry.role === "robot") continue;
        humans.push({
            uid: null,
            email: null,
            alias: key,
            identity: key,
            assignmentKeys: [key],
            assignedRobots: trueKeys(entry.robots),
            assignedMaps: trueKeys(entry.maps),
            hasSplitAssignments: false,
        });
    }

    humans.sort((a, b) => {
        const labelA = (a.email || a.identity).toLowerCase();
        const labelB = (b.email || b.identity).toLowerCase();
        return labelA.localeCompare(labelB);
    });

    const cloudMapIds = Object.keys(mapKeys).sort();
    const allMaps = new Set(cloudMapIds);
    for (const entry of Object.values(assignments)) {
        if (!isPlainObject(entry)) continue;
        for (const m of trueKeys(entry.maps)) allMaps.add(m);
    }

    return {
        humans,
        robots,
        mapIds: [...allMaps].sort(),
        cloudMapIds,
    };
}

/**
 * Summarize a patch value without printing megabytes of base64 map data.
 *
 * @param {unknown} value Value assigned to a patch path.
 * @returns {string} Compact single-line representation.
 */
function summarizePatchValue(value) {
    if (isPlainObject(value) && typeof value.pgm_base64 === "string") {
        const byteCount = Buffer.from(value.pgm_base64, "base64").length;
        return JSON.stringify({
            name: value.name,
            pgm_filename: value.pgm_filename,
            pgm_bytes: byteCount,
        });
    }
    return JSON.stringify(value);
}

/**
 * Format a multi-location Realtime Database patch into human-readable diff entries.
 *
 * @param {Record<string, unknown>} patch Multi-location patch object.
 * @returns {{mark: "+" | "-", path: string, summary: string}[]} Sorted diff lines.
 */
function formatPatchLines(patch) {
    const clean = assertDisjointPatchPaths(patch);
    return Object.keys(clean)
        .sort()
        .map((p) => {
            const val = clean[p];
            if (val === null) {
                return { mark: "-", path: `/${p}`, summary: "DELETE" };
            }
            return {
                mark: "+",
                path: `/${p}`,
                summary: summarizePatchValue(val),
            };
        });
}

/**
 * Print formatted patch lines to stdout using terminal colors when supported.
 *
 * @param {Record<string, unknown>} patch Multi-location patch object.
 * @param {string} projectId Target Firebase project ID.
 * @returns {void}
 */
function printPatchPreview(patch, projectId) {
    const colour =
        !process.env.NO_COLOR &&
        Boolean(process.stdout.isTTY || process.env.CI);
    const green = colour ? "\x1b[0;32m" : "";
    const red = colour ? "\x1b[0;31m" : "";
    const cyan = colour ? "\x1b[0;36m" : "";
    const reset = colour ? "\x1b[0m" : "";

    const lines = formatPatchLines(patch);
    console.log(
        `\n${cyan}Planned Realtime Database changes on "${projectId}" (${lines.length} path${lines.length === 1 ? "" : "s"}):${reset}`
    );
    for (const line of lines) {
        if (line.mark === "-") {
            console.log(`  ${red}- ${line.path}${reset}`);
        } else {
            console.log(`  ${green}+ ${line.path} = ${line.summary}${reset}`);
        }
    }
    console.log("");
}

/**
 * Apply a multi-location `PATCH` atomically at the Realtime Database root (`/.json`).
 *
 * @param {Client} dbClient Authenticated Realtime Database client.
 * @param {Record<string, unknown>} patch Multi-location patch object.
 * @returns {Promise<boolean>} True when changes were written, false when `patch` was empty.
 * @throws {Error} When paths overlap or Realtime Database rejects the write.
 */
async function applyRootPatch(dbClient, patch) {
    const clean = assertDisjointPatchPaths(patch);
    if (Object.keys(clean).length === 0) {
        return false;
    }
    try {
        const res = await dbClient.request({
            method: "PATCH",
            path: "/.json",
            body: clean,
            resolveOnHTTPError: true,
            skipLog: { reqBody: true, resBody: true },
        });
        if (res.status >= 400) {
            const detail =
                typeof res.body?.error === "string"
                    ? res.body.error
                    : `HTTP ${res.status}`;
            throw new Error(detail);
        }
        return true;
    } catch (err) {
        throw new Error("atomic Realtime Database PATCH failed", {
            cause: err,
        });
    }
}

module.exports = {
    applyRootPatch,
    assertDisjointPatchPaths,
    authenticateAdmin,
    classifyDirectory,
    createAdminClients,
    createAuthUser,
    deleteAuthUser,
    fetchAdminSnapshot,
    formatPatchLines,
    isPlainObject,
    listAuthUsers,
    normalizePatchPath,
    printPatchPreview,
    readDbPath,
    readFirebaseEnv,
    summarizePatchValue,
    trueKeys,
    validateRtdbKey,
};
