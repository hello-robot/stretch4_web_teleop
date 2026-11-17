#!/usr/bin/env node

/**
 * Upload a ROS 2 `.yaml` + `.pgm` map to Firebase Realtime Database and
 * interactively assign access to operators and robots.
 *
 * Usage:
 *   npm run firebase:upload-map -- <path/to/map.yaml>
 *   npm run firebase:upload-map -- <path/to/map.yaml> --id <mapId>
 *   npm run firebase:upload-map -- <path/to/map.yaml> --dry-run
 */

const fs = require("node:fs");
const path = require("node:path");

const { checkbox, confirm, input } = require("firebase-tools/lib/prompt");

const {
    applyRootPatch,
    assertDisjointPatchPaths,
    authenticateAdmin,
    classifyDirectory,
    createAdminClients,
    fetchAdminSnapshot,
    isPlainObject,
    printPatchPreview,
    readDbPath,
    readFirebaseEnv,
    validateRtdbKey,
} = require("./firebaseAdminClient");

const USAGE = `Usage: npm run firebase:upload-map -- [<path/to/map.yaml>] [options]

Upload a ROS 2 map (.yaml + .pgm) to Realtime Database (/maps/<mapId>) and
select which operators and robots have access to it.

Options:
  --id <mapId>   Override map ID (defaults to the .yaml filename stem)
  --dry-run      Preview Realtime Database changes without uploading
  -h, --help     Print this help message`;

/** Netpbm ASCII (P2) or binary (P5) PGM magic prefix followed by whitespace or comment. */
const PGM_HEADER = /^P[25][\s#]/;

/**
 * Parse command-line arguments for `uploadMap.js`.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{yamlPath: string | null, mapId: string | null, dryRun: boolean, help: boolean}} Parsed options.
 * @throws {Error} When unknown options or multiple positional paths are supplied.
 */
function parseArgs(argv) {
    let yamlPath = null;
    let mapId = null;
    let dryRun = Boolean(process.env.npm_config_dry_run);
    let help = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "-h" || arg === "--help") {
            help = true;
        } else if (arg === "--id") {
            const next = argv[i + 1];
            if (!next || next.startsWith("-")) {
                throw new Error("--id requires a map ID value");
            }
            mapId = next;
            i++;
        } else if (arg.startsWith("--id=")) {
            const val = arg.slice("--id=".length);
            if (!val) {
                throw new Error("--id requires a map ID value");
            }
            mapId = val;
        } else if (arg.startsWith("-")) {
            throw new Error(`unknown argument: ${arg}`);
        } else if (yamlPath === null) {
            yamlPath = arg;
        } else {
            throw new Error(`unexpected positional argument: ${arg}`);
        }
    }

    return { yamlPath, mapId, dryRun, help };
}

/**
 * Strip surrounding matching quotes and trailing unquoted `#` comments from a YAML scalar.
 *
 * @param {string} raw Raw value substring after `image:`.
 * @returns {string} Cleaned scalar string.
 */
function parseYamlScalar(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (
        (trimmed.startsWith('"') && trimmed.includes('"', 1)) ||
        (trimmed.startsWith("'") && trimmed.includes("'", 1))
    ) {
        const quote = trimmed[0];
        const closeIdx = trimmed.indexOf(quote, 1);
        return trimmed.slice(1, closeIdx).trim();
    }
    const commentIdx = trimmed.search(/\s+#/);
    const withoutComment =
        commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed;
    return withoutComment.replace(/^#.*$/, "").trim();
}

/**
 * Extract the `image:` path from ROS 2 map YAML text and optionally rewrite it to `basename`.
 *
 * `stretch_firebase_daemon.js` writes downloaded map files side-by-side inside
 * `~/stretch_user/maps/<mapId>/`, so any directory prefix in `image:` is normalized
 * to the `.pgm` basename in the uploaded YAML content.
 *
 * @param {string} yamlContent Raw `.yaml` file contents.
 * @returns {{imageRef: string, normalizeYaml: (pgmBasename: string) => string}} Parsed image reference and YAML normalizer.
 * @throws {Error} When no valid top-level `image:` entry is present.
 */
function parseMapYamlImage(yamlContent) {
    const lines = yamlContent.split(/\r?\n/);
    let imageLineIndex = -1;
    let imageRef = "";

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^image\s*:\s*(.*)$/);
        if (match) {
            imageLineIndex = i;
            imageRef = parseYamlScalar(match[1]);
            break;
        }
    }

    if (imageLineIndex < 0 || !imageRef) {
        throw new Error('map YAML is missing a non-empty "image:" field');
    }

    return {
        imageRef,
        normalizeYaml: (pgmBasename) => {
            if (imageRef === pgmBasename) {
                return yamlContent;
            }
            const copy = [...lines];
            copy[imageLineIndex] = `image: ${pgmBasename}`;
            return copy.join("\n");
        },
    };
}

/**
 * Read and validate a ROS 2 `.yaml` + `.pgm` map pair from disk.
 *
 * @param {string} yamlFilePath Path to the `.yaml` or `.yml` map metadata file.
 * @param {string | null} [mapIdOverride] Optional custom map ID overriding the YAML stem.
 * @returns {{
 *   mapId: string,
 *   yamlPath: string,
 *   pgmPath: string,
 *   pgmBytes: number,
 *   record: {
 *     name: string,
 *     yaml_content: string,
 *     pgm_filename: string,
 *     pgm_base64: string
 *   }
 * }} Validated map metadata and Realtime Database payload.
 * @throws {Error} When the YAML or PGM file is missing, non-PGM, or malformed.
 */
function loadMapPayload(yamlFilePath, mapIdOverride = null) {
    if (typeof yamlFilePath !== "string" || !yamlFilePath.trim()) {
        throw new Error("a path to a map .yaml file is required");
    }
    const resolvedYaml = path.resolve(yamlFilePath.trim());
    const ext = path.extname(resolvedYaml).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") {
        throw new Error(
            `expected a .yaml or .yml file, got "${path.basename(resolvedYaml)}"`
        );
    }
    if (!fs.existsSync(resolvedYaml) || !fs.statSync(resolvedYaml).isFile()) {
        throw new Error(`map YAML file not found: ${resolvedYaml}`);
    }

    const stem = path.basename(resolvedYaml, ext);
    const mapId = validateRtdbKey(mapIdOverride || stem, "map ID");

    const rawYaml = fs.readFileSync(resolvedYaml, "utf8");
    const { imageRef, normalizeYaml } = parseMapYamlImage(rawYaml);

    const resolvedPgm = path.isAbsolute(imageRef)
        ? imageRef
        : path.resolve(path.dirname(resolvedYaml), imageRef);

    if (path.extname(resolvedPgm).toLowerCase() !== ".pgm") {
        throw new Error(
            `expected "image:" in YAML to reference a .pgm file, got "${imageRef}"`
        );
    }
    if (!fs.existsSync(resolvedPgm) || !fs.statSync(resolvedPgm).isFile()) {
        throw new Error(
            `PGM file referenced by YAML not found: ${resolvedPgm}`
        );
    }

    const pgmBuffer = fs.readFileSync(resolvedPgm);
    if (pgmBuffer.length === 0) {
        throw new Error(`PGM file is empty: ${resolvedPgm}`);
    }
    const headerPreview = pgmBuffer.subarray(0, 16).toString("latin1");
    if (!PGM_HEADER.test(headerPreview)) {
        throw new Error(
            `file does not have a valid P2/P5 PGM header: ${resolvedPgm}`
        );
    }

    const pgmFilename = path.basename(resolvedPgm);
    if (
        !pgmFilename ||
        pgmFilename === "." ||
        pgmFilename === ".." ||
        pgmFilename.includes("/") ||
        pgmFilename.includes("\\")
    ) {
        throw new Error(`invalid PGM filename "${pgmFilename}"`);
    }
    const normalizedYaml = normalizeYaml(pgmFilename);

    return {
        mapId,
        yamlPath: resolvedYaml,
        pgmPath: resolvedPgm,
        pgmBytes: pgmBuffer.length,
        record: {
            name: mapId,
            yaml_content: normalizedYaml,
            pgm_filename: pgmFilename,
            pgm_base64: pgmBuffer.toString("base64"),
        },
    };
}

/**
 * Build an atomic multi-location patch writing `/maps/<mapId>` and updating operator and robot map grants.
 *
 * Preserves existing `owner_uid`, `allowed_users`, or `thumb_png_base64` fields on `/maps/<mapId>`
 * when updating an existing cloud map, and clears unchecked human grants from both `<alias>` and `<authUid>`.
 *
 * @param {{
 *   snapshot: {
 *     assignments?: Record<string, Record<string, unknown>>
 *   },
 *   directory: ReturnType<typeof classifyDirectory>,
 *   mapId: string,
 *   mapRecord: {
 *     name: string,
 *     yaml_content: string,
 *     pgm_filename: string,
 *     pgm_base64: string
 *   },
 *   existingMapRecord?: Record<string, unknown> | null,
 *   selectedUserIdentities: string[],
 *   selectedRobotFleetIds: string[]
 * }} params Upload and access selection parameters.
 * @returns {Record<string, unknown>} Disjoint multi-location RTDB patch.
 */
function buildMapUploadPatch(params) {
    const cleanMapId = validateRtdbKey(params.mapId, "map ID");
    const assignments = isPlainObject(params.snapshot.assignments)
        ? params.snapshot.assignments
        : {};

    const preservedMeta = {};
    if (isPlainObject(params.existingMapRecord)) {
        for (const key of ["owner_uid", "allowed_users", "thumb_png_base64"]) {
            if (params.existingMapRecord[key] !== undefined) {
                preservedMeta[key] = params.existingMapRecord[key];
            }
        }
    }

    const patch = {
        [`maps/${cleanMapId}`]: {
            ...preservedMeta,
            ...params.mapRecord,
        },
    };

    const selectedUsers = new Set(params.selectedUserIdentities);
    for (const human of params.directory.humans) {
        if (selectedUsers.has(human.identity)) {
            if (assignments[human.identity]?.maps?.[cleanMapId] !== true) {
                patch[`assignments/${human.identity}/maps/${cleanMapId}`] =
                    true;
            }
            if (
                human.uid &&
                human.uid !== human.identity &&
                assignments[human.uid]?.maps?.[cleanMapId] !== undefined
            ) {
                patch[`assignments/${human.uid}/maps/${cleanMapId}`] = null;
            }
        } else {
            for (const key of human.assignmentKeys) {
                if (assignments[key]?.maps?.[cleanMapId] !== undefined) {
                    patch[`assignments/${key}/maps/${cleanMapId}`] = null;
                }
            }
        }
    }

    const selectedRobots = new Set(
        params.selectedRobotFleetIds.map((r) =>
            validateRtdbKey(r, "robot fleet ID")
        )
    );
    const knownFleetIds = new Set(
        params.directory.robots.map((r) => r.fleetId)
    );
    for (const r of selectedRobots) knownFleetIds.add(r);

    for (const fleetId of [...knownFleetIds].sort()) {
        if (selectedRobots.has(fleetId)) {
            if (assignments[fleetId]?.maps?.[cleanMapId] !== true) {
                patch[`assignments/${fleetId}/maps/${cleanMapId}`] = true;
            }
        } else if (assignments[fleetId]?.maps?.[cleanMapId] !== undefined) {
            patch[`assignments/${fleetId}/maps/${cleanMapId}`] = null;
        }
    }

    return assertDisjointPatchPaths(patch);
}

/**
 * Entrypoint for `npm run firebase:upload-map`.
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
            "firebase:upload-map requires an interactive terminal (TTY)"
        );
    }

    let yamlPath = opts.yamlPath;
    if (!yamlPath) {
        yamlPath = await input({
            message: "Path to ROS 2 map .yaml file:",
            validate: (v) =>
                v && v.trim() ? true : "Enter a path to a .yaml file",
        });
    }

    const payload = loadMapPayload(yamlPath, opts.mapId);
    console.log(
        `Loaded map "${payload.mapId}" (${payload.record.pgm_filename}, ${payload.pgmBytes} bytes).`
    );

    const { projectId, databaseOrigin } = readFirebaseEnv();
    const actor = await authenticateAdmin(projectId);
    console.log(`Authenticated to "${projectId}" as ${actor}.`);

    const clients = createAdminClients(databaseOrigin);
    const snapshot = await fetchAdminSnapshot(projectId, clients);
    const directory = classifyDirectory(snapshot);

    let existingMapRecord = null;
    if (directory.cloudMapIds.includes(payload.mapId)) {
        const fetched = await readDbPath(
            clients.dbClient,
            `/maps/${payload.mapId}`
        );
        if (isPlainObject(fetched)) {
            existingMapRecord = fetched;
            console.log(
                `Note: /maps/${payload.mapId} already exists in "${projectId}" and will be updated.`
            );
        }
    }

    let selectedUsers = [];
    if (directory.humans.length > 0) {
        selectedUsers = await checkbox({
            message: `Check operators permitted to access map "${payload.mapId}":`,
            choices: directory.humans.map((h) => ({
                name: h.email ? `${h.email} (${h.identity})` : h.identity,
                value: h.identity,
                checked: h.assignedMaps.includes(payload.mapId),
            })),
        });
    } else {
        console.log("No human operator accounts exist yet.");
    }

    let selectedRobots = [];
    if (directory.robots.length > 0) {
        selectedRobots = await checkbox({
            message: `Check robots permitted to download map "${payload.mapId}":`,
            choices: directory.robots.map((r) => ({
                name: `${r.fleetId} (${r.status}${r.buildDescribe ? `, ${r.buildDescribe}` : ""})`,
                value: r.fleetId,
                checked: r.assignedMaps.includes(payload.mapId),
            })),
        });
    } else {
        console.log("No robots are currently registered in Realtime Database.");
    }

    if (selectedUsers.length > 0 && selectedRobots.length === 0) {
        console.warn(
            `\nWarning: ${selectedUsers.length} operator(s) selected, and 0 robots selected.\n` +
                `Robots without ~/stretch_user/maps/${payload.mapId}.yaml already on disk need a robot grant to download /maps/${payload.mapId}.`
        );
    }

    const patch = buildMapUploadPatch({
        snapshot,
        directory,
        mapId: payload.mapId,
        mapRecord: payload.record,
        existingMapRecord,
        selectedUserIdentities: selectedUsers,
        selectedRobotFleetIds: selectedRobots,
    });

    printPatchPreview(patch, projectId);
    if (opts.dryRun) {
        console.log("Dry run complete; nothing was uploaded.");
        return;
    }

    const ok = await confirm({
        message: `Upload map "${payload.mapId}" and apply access changes to "${projectId}"?`,
        default: false,
    });
    if (!ok) {
        console.log("Aborted; nothing was uploaded.");
        return;
    }

    await applyRootPatch(clients.dbClient, patch);
    console.log(`Uploaded /maps/${payload.mapId} and updated grants.`);
}

module.exports = {
    buildMapUploadPatch,
    loadMapPayload,
    parseArgs,
    parseMapYamlImage,
    parseYamlScalar,
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
