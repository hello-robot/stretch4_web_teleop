/**
 * Offline unit tests for `uploadMap.js`: CLI option parsing, ROS 2 `.yaml` +
 * `.pgm` validation and `image:` basename normalization, and atomic map +
 * dual-grant Realtime Database patch construction.
 *
 * Daemon-side map consumption (`ensureMapLocal`) and Realtime Database rule
 * enforcement live in `scripts/stretch_firebase_daemon.js` and
 * `test/firebase/firebase-database-rules.test.mjs`.
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

const { classifyDirectory } = require("../../scripts/firebaseAdminClient.js");
const {
    buildMapUploadPatch,
    loadMapPayload,
    parseArgs,
} = require("../../scripts/uploadMap.js");

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
 * Create a valid minimal binary P5 PGM buffer.
 *
 * @returns {Buffer} 2x2 binary PGM file contents.
 */
function sampleP5Pgm() {
    return Buffer.concat([
        Buffer.from("P5\n# sample map\n2 2\n255\n", "ascii"),
        Buffer.from([0, 128, 205, 254]),
    ]);
}

suite("uploadMap CLI argument parsing", () => {
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

    test("parses optional yaml path, --id forms, --dry-run, and --help", () => {
        assert.deepEqual(parseArgs([]), {
            yamlPath: null,
            mapId: null,
            dryRun: false,
            help: false,
        });
        assert.deepEqual(
            parseArgs(["maps/lab.yaml", "--id", "lab_v2", "--dry-run"]),
            {
                yamlPath: "maps/lab.yaml",
                mapId: "lab_v2",
                dryRun: true,
                help: false,
            }
        );
        assert.deepEqual(parseArgs(["--id=custom_id", "maps/lab.yaml"]), {
            yamlPath: "maps/lab.yaml",
            mapId: "custom_id",
            dryRun: false,
            help: false,
        });
    });

    test("rejects missing --id value, duplicate positional arguments, and unknown flags", () => {
        assert.throws(
            () => parseArgs(["maps/lab.yaml", "--id"]),
            /--id requires a map ID value/
        );
        assert.throws(
            () => parseArgs(["maps/a.yaml", "maps/b.yaml"]),
            /unexpected positional argument: maps\/b\.yaml/
        );
        assert.throws(
            () => parseArgs(["--unknown"]),
            /unknown argument: --unknown/
        );
        // Positive control: single path + valid --id succeeds.
        assert.equal(
            parseArgs(["maps/a.yaml", "--id", "valid_id"]).mapId,
            "valid_id"
        );
    });
});

suite(
    "loadMapPayload validates YAML and PGM inputs and normalizes image paths",
    () => {
        test("loads a standard sibling .yaml + P5 .pgm pair and derives mapId from stem", () => {
            const dir = makeTempDir("map-sibling");
            const yamlFile = path.join(dir, "downstairs_clean.yaml");
            const pgmFile = path.join(dir, "map.pgm");
            const pgmBytes = sampleP5Pgm();
            const yamlText = [
                "image: map.pgm",
                "mode: trinary",
                "resolution: 0.05",
                "origin: [-10.0, -9.0, 0.0]",
                "",
            ].join("\n");

            fs.writeFileSync(pgmFile, pgmBytes);
            fs.writeFileSync(yamlFile, yamlText, "utf8");

            const loaded = loadMapPayload(yamlFile);
            assert.equal(loaded.mapId, "downstairs_clean");
            assert.equal(loaded.pgmBytes, pgmBytes.length);
            assert.equal(loaded.record.name, "downstairs_clean");
            assert.equal(loaded.record.pgm_filename, "map.pgm");
            assert.equal(loaded.record.yaml_content, yamlText);
            assert.deepEqual(
                Buffer.from(loaded.record.pgm_base64, "base64"),
                pgmBytes
            );
        });

        test("resolves nested/quoted image paths, strips comments, and rewrites image: to basename", () => {
            const dir = makeTempDir("map-nested");
            const subDir = path.join(dir, "scans");
            fs.mkdirSync(subDir);
            const pgmFile = path.join(subDir, "floor2.pgm");
            fs.writeFileSync(
                pgmFile,
                Buffer.from("P2\n1 1\n255\n200\n", "ascii")
            );

            const yamlFile = path.join(dir, "hq.yml");
            fs.writeFileSync(
                yamlFile,
                '# generated map\nimage: "./scans/floor2.pgm" # inline comment\nresolution: 0.05\n',
                "utf8"
            );

            const loaded = loadMapPayload(yamlFile, "hq_floor2");
            assert.equal(loaded.mapId, "hq_floor2");
            assert.equal(loaded.record.pgm_filename, "floor2.pgm");
            assert.match(loaded.record.yaml_content, /^image: floor2\.pgm$/m);
            assert.doesNotMatch(loaded.record.yaml_content, /\.\/scans\//);
        });

        test("rejects non-YAML paths, missing image:, non-.pgm images, missing/empty PGM, and non-PGM headers", () => {
            const dir = makeTempDir("map-errors");
            const validPgm = path.join(dir, "ok.pgm");
            fs.writeFileSync(validPgm, sampleP5Pgm());

            const txtFile = path.join(dir, "bad.txt");
            fs.writeFileSync(txtFile, "image: ok.pgm\n");
            assert.throws(
                () => loadMapPayload(txtFile),
                /expected a \.yaml or \.yml file/
            );

            assert.throws(
                () => loadMapPayload(path.join(dir, "missing.yaml")),
                /map YAML file not found/
            );

            const noImageYaml = path.join(dir, "no_image.yaml");
            fs.writeFileSync(noImageYaml, "resolution: 0.05\n");
            assert.throws(
                () => loadMapPayload(noImageYaml),
                /missing a non-empty "image:" field/
            );

            const pngFile = path.join(dir, "scan.png");
            fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            const pngYaml = path.join(dir, "png_ref.yaml");
            fs.writeFileSync(pngYaml, "image: scan.png\n");
            assert.throws(
                () => loadMapPayload(pngYaml),
                /expected "image:" in YAML to reference a \.pgm file/
            );

            const missingPgmYaml = path.join(dir, "missing_pgm.yaml");
            fs.writeFileSync(missingPgmYaml, "image: ghost.pgm\n");
            assert.throws(
                () => loadMapPayload(missingPgmYaml),
                /PGM file referenced by YAML not found/
            );

            const emptyPgm = path.join(dir, "empty.pgm");
            fs.writeFileSync(emptyPgm, Buffer.alloc(0));
            const emptyYaml = path.join(dir, "empty_ref.yaml");
            fs.writeFileSync(emptyYaml, "image: empty.pgm\n");
            assert.throws(() => loadMapPayload(emptyYaml), /PGM file is empty/);

            const fakePgm = path.join(dir, "fake.pgm");
            fs.writeFileSync(
                fakePgm,
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])
            );
            const fakeYaml = path.join(dir, "fake_ref.yaml");
            fs.writeFileSync(fakeYaml, "image: fake.pgm\n");
            assert.throws(
                () => loadMapPayload(fakeYaml),
                /does not have a valid P2\/P5 PGM header/
            );

            // Positive control in the same directory with valid ok.pgm succeeds.
            const goodYaml = path.join(dir, "good.yaml");
            fs.writeFileSync(goodYaml, "image: ok.pgm\n");
            assert.equal(loadMapPayload(goodYaml).mapId, "good");
        });
    }
);

suite(
    "buildMapUploadPatch writes map payload and dual operator/robot grants",
    () => {
        test("preserves existing map metadata, adds checked grants, and removes unchecked grants across aliases", () => {
            const snapshot = {
                authUsers: [
                    { uid: "uid-alice", email: "alice@example.com" },
                    { uid: "uid-bob", email: "bob@example.com" },
                    { uid: "uid-r1", email: "r1@example.com" },
                ],
                uids: { "uid-alice": "alice" },
                assignments: {
                    alice: { maps: { lab: true } },
                    "uid-alice": { maps: { lab: true } },
                    "uid-bob": {},
                    "uid-r1": { role: "robot", name: "stretch-se4-4001" },
                    "stretch-se4-4001": { maps: { lab: true } },
                    "stretch-se4-4002": {},
                },
                robots: {
                    "stretch-se4-4001": { uid: "uid-r1", status: "standby" },
                    "stretch-se4-4002": { status: "offline" },
                },
                mapKeys: { lab: true },
            };
            const directory = classifyDirectory(snapshot);

            const mapRecord = {
                name: "lab",
                yaml_content: "image: lab.pgm\n",
                pgm_filename: "lab.pgm",
                pgm_base64: "UDUKMSAxCjI1NQo=",
            };

            const patch = buildMapUploadPatch({
                snapshot,
                directory,
                mapId: "lab",
                mapRecord,
                existingMapRecord: {
                    name: "lab",
                    owner_uid: "alice",
                    allowed_users: { alice: true },
                },
                // Uncheck alice (clears both alice and uid-alice), check uid-bob:
                selectedUserIdentities: ["uid-bob"],
                // Uncheck 4001, check 4002:
                selectedRobotFleetIds: ["stretch-se4-4002"],
            });

            assert.deepEqual(patch, {
                "maps/lab": {
                    owner_uid: "alice",
                    allowed_users: { alice: true },
                    ...mapRecord,
                },
                "assignments/alice/maps/lab": null,
                "assignments/uid-alice/maps/lab": null,
                "assignments/uid-bob/maps/lab": true,
                "assignments/stretch-se4-4001/maps/lab": null,
                "assignments/stretch-se4-4002/maps/lab": true,
            });
        });
    }
);
