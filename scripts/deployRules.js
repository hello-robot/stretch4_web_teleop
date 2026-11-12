#!/usr/bin/env node

/**
 * deployRules.js
 *
 * Publish database.rules.json, after showing what publishing it would change.
 *
 * A rules deploy replaces the entire live ruleset rather than patching it, so
 * a repository copy that has fallen behind silently reverts whatever it is
 * missing. Every run therefore pulls the live rules first, prints a line by
 * line diff, and waits for the practitioner to agree before applying it.
 *
 * Usage:
 *   node scripts/deployRules.js               diff, confirm, then deploy
 *   node scripts/deployRules.js --no-check    deploy without the diff or the prompt
 *   node scripts/deployRules.js --help        print this usage
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { spawnSync } = require("child_process");

const { envProjectId, syncFirebaseRc } = require("./syncFirebaseRc");

const repoRoot = path.join(__dirname, "..");
const rulesPath = path.join(repoRoot, "database.rules.json");
const firebaseBin = path.join(repoRoot, "node_modules", ".bin", "firebase");

/** Where the Realtime Database keeps the ruleset it is enforcing. */
const LIVE_RULES_PATH = "/.settings/rules";

/** Lines of unchanged context printed either side of a change. */
const DIFF_CONTEXT = 3;

// Same palette the other deploy scripts use. Actions renders ANSI without
// being a terminal.
const COLOUR =
    !process.env.NO_COLOR && Boolean(process.stdout.isTTY || process.env.CI);
const RED = COLOUR ? "\x1b[0;31m" : "";
const GREEN = COLOUR ? "\x1b[0;32m" : "";
const CYAN = COLOUR ? "\x1b[0;36m" : "";
const NC = COLOUR ? "\x1b[0m" : "";

/**
 * Report a check that passed.
 *
 * @param {string} message The requirement that held.
 * @param {string} [detail] The values it held for.
 * @returns {void}
 */
function pass(message, detail) {
    console.log(`${GREEN}✓ ${message}${NC}`);
    if (detail) console.log(`    ${detail}`);
}

/**
 * Check whether npm negated a boolean flag into process.env when the caller
 * omitted `--` before it.
 *
 * `npm run deploy:rules --no-check` never reaches argv: npm consumes it and
 * exports npm_config_check as an empty string, where a plain truthiness test
 * would read it as absent and prompt anyway. An explicit "false" is accepted
 * too, since npm has spelled it both ways.
 *
 * @param {string} name Environment variable name (e.g. npm_config_check).
 * @returns {boolean} True when npm saw the flag negated.
 */
function npmConfigNegated(name) {
    const val = process.env[name];
    return val === "" || val === "false";
}

/**
 * Interpret the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{noCheck: boolean, help: boolean}} Parsed options.
 * @throws {Error} When an unrecognised argument is given.
 */
function parseArgs(argv) {
    const options = {
        noCheck: npmConfigNegated("npm_config_check"),
        help: false,
    };
    for (const arg of argv) {
        if (arg === "--no-check") {
            options.noCheck = true;
        } else if (arg === "--check") {
            throw new Error(
                "--check is now the default; pass --no-check to deploy without the diff and the prompt"
            );
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

/**
 * Re-serialise a ruleset so two copies can be compared on their content.
 *
 * The database returns the rules re-encoded, so comments and whitespace from
 * the repository copy never survive the round trip. Both sides are parsed and
 * printed the same way, leaving a diff that reports rule changes only.
 *
 * @param {string} text Raw JSON text.
 * @param {string} source Where the text came from, for the error message.
 * @returns {string[]} Normalised lines.
 * @throws {Error} When the text is not valid JSON.
 */
function normalise(text, source) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`${source} is not valid JSON: ${error.message}`);
    }
    return JSON.stringify(parsed, null, 2).split("\n");
}

/**
 * Read the ruleset the project is currently enforcing.
 *
 * @param {string} projectId Project the rules are read from, for the message.
 * @returns {string[]} Normalised lines of the live ruleset.
 * @throws {Error} When the CLI cannot reach the database.
 */
function readLiveRules(projectId) {
    const result = spawnSync(firebaseBin, ["database:get", LIVE_RULES_PATH], {
        cwd: repoRoot,
        encoding: "utf8",
    });
    if (result.status !== 0) {
        const reason = (result.stderr || result.stdout || "").trim();
        throw new Error(
            `could not read the live rules of ${projectId}` +
                `${reason ? `:\n${reason}` : ""}`
        );
    }
    return normalise(result.stdout, `the live rules of ${projectId}`);
}

/**
 * Longest-common-subsequence diff of two line sequences.
 *
 * Written here rather than pulled in, because one diff of a few hundred lines
 * does not earn a dependency.
 *
 * @param {string[]} before Lines on the left.
 * @param {string[]} after Lines on the right.
 * @returns {{mark: string, text: string}[]} Operations in output order, marked
 *     " " for common, "-" for left only, and "+" for right only.
 */
function diffLines(before, after) {
    const n = before.length;
    const m = after.length;
    const common = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            common[i][j] =
                before[i] === after[j]
                    ? common[i + 1][j + 1] + 1
                    : Math.max(common[i + 1][j], common[i][j + 1]);
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) {
            ops.push({ mark: " ", text: before[i] });
            i += 1;
            j += 1;
        } else if (common[i + 1][j] >= common[i][j + 1]) {
            ops.push({ mark: "-", text: before[i] });
            i += 1;
        } else {
            ops.push({ mark: "+", text: after[j] });
            j += 1;
        }
    }
    while (i < n) {
        ops.push({ mark: "-", text: before[i] });
        i += 1;
    }
    while (j < m) {
        ops.push({ mark: "+", text: after[j] });
        j += 1;
    }
    return ops;
}

/**
 * Group changed lines into hunks, each padded with unchanged context.
 *
 * @param {{mark: string, text: string}[]} ops Diff operations.
 * @param {number} context Unchanged lines to keep either side of a change.
 * @returns {{beforeStart: number, beforeCount: number, afterStart: number,
 *     afterCount: number, ops: {mark: string, text: string}[]}[]} Hunks in
 *     order, empty when nothing changed.
 */
function hunk(ops, context) {
    // Number every operation against both files before anything is dropped,
    // so a hunk header can be written from the lines it actually kept.
    let beforeNo = 0;
    let afterNo = 0;
    const numbered = ops.map((op) => {
        if (op.mark !== "+") beforeNo += 1;
        if (op.mark !== "-") afterNo += 1;
        return {
            ...op,
            beforeNo: op.mark === "+" ? null : beforeNo,
            afterNo: op.mark === "-" ? null : afterNo,
        };
    });

    const keep = new Array(numbered.length).fill(false);
    numbered.forEach((op, index) => {
        if (op.mark === " ") return;
        const from = Math.max(0, index - context);
        const to = Math.min(numbered.length - 1, index + context);
        for (let k = from; k <= to; k += 1) keep[k] = true;
    });

    const hunks = [];
    let current = null;
    numbered.forEach((op, index) => {
        if (!keep[index]) {
            current = null;
            return;
        }
        if (!current) {
            current = { ops: [] };
            hunks.push(current);
        }
        current.ops.push(op);
    });

    return hunks.map((entry) => {
        const beforeLines = entry.ops.filter((op) => op.mark !== "+");
        const afterLines = entry.ops.filter((op) => op.mark !== "-");
        return {
            beforeStart: beforeLines.length ? beforeLines[0].beforeNo : 0,
            beforeCount: beforeLines.length,
            afterStart: afterLines.length ? afterLines[0].afterNo : 0,
            afterCount: afterLines.length,
            ops: entry.ops,
        };
    });
}

/**
 * Print a unified diff of the live ruleset against the repository copy.
 *
 * @param {string[]} live Normalised lines of the live ruleset.
 * @param {string[]} local Normalised lines of the repository copy.
 * @param {string} projectId Project the live rules came from.
 * @returns {boolean} True when the two agree.
 */
function printDiff(live, local, projectId) {
    const hunks = hunk(diffLines(live, local), DIFF_CONTEXT);
    if (!hunks.length) {
        pass(
            "the live rules match database.rules.json",
            `${projectId}, ${live.length} lines`
        );
        return true;
    }

    console.log(`${RED}--- live${NC}      ${projectId}${LIVE_RULES_PATH}`);
    console.log(`${GREEN}+++ local${NC}     database.rules.json`);
    for (const entry of hunks) {
        console.log(
            `${CYAN}@@ -${entry.beforeStart},${entry.beforeCount}` +
                ` +${entry.afterStart},${entry.afterCount} @@${NC}`
        );
        for (const op of entry.ops) {
            const colour = op.mark === "+" ? GREEN : op.mark === "-" ? RED : "";
            const close = colour ? NC : "";
            console.log(`${colour}${op.mark}${op.text}${close}`);
        }
    }

    const added = hunks.reduce(
        (total, entry) =>
            total + entry.ops.filter((op) => op.mark === "+").length,
        0
    );
    const removed = hunks.reduce(
        (total, entry) =>
            total + entry.ops.filter((op) => op.mark === "-").length,
        0
    );
    console.log(
        `\ndeploying would apply ${GREEN}${added} added${NC}` +
            ` and ${RED}${removed} removed${NC} line(s) to ${projectId}.`
    );
    if (removed) {
        console.log(
            `${RED}Removed lines are rules the project enforces today.${NC}` +
                " Check they are meant to go before deploying."
        );
    }
    return false;
}

/**
 * Decide whether an answer to the confirmation prompt is consent.
 *
 * Only y and yes count, in any case and with surrounding space ignored.
 * Everything else, the empty answer included, is a refusal.
 *
 * @param {string} answer What the practitioner typed.
 * @returns {boolean} True only for an explicit yes.
 */
function isYes(answer) {
    return /^y(es)?$/i.test(String(answer).trim());
}

/**
 * Ask the practitioner whether to apply the diff just printed.
 *
 * Anything but an explicit yes is a no, so a stray keypress or a closed stdin
 * leaves the live rules alone.
 *
 * @param {string} question Prompt to display.
 * @returns {Promise<boolean>} True only when the answer was y or yes.
 */
async function confirm(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const answer = await rl.question(question);
        return isYes(answer);
    } catch {
        // A closed stdin is not consent.
        return false;
    } finally {
        rl.close();
    }
}

/**
 * Run a command, streaming its output.
 *
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments.
 * @returns {void}
 * @throws {Error} When the command exits non-zero.
 */
function run(command, args) {
    const label = `${path.basename(command)} ${args.join(" ")}`;
    // npm exports an unseparated --no-check into the child environment, where
    // a nested npm run would read it back as its own flag.
    const { npm_config_check: _check, ...env } = process.env;
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        env,
    });
    if (result.status !== 0) throw new Error(`${label} failed`);
}

/**
 * Point .firebaserc at the project in .env and report which one that is.
 *
 * @returns {string} The project id the Firebase CLI will act on.
 * @throws {Error} When .env names no project.
 */
function resolveProject() {
    const projectId = envProjectId();
    if (!projectId) {
        throw new Error(
            "no PUBLIC_FIREBASE_PROJECT_ID in .env, so there is no project to read or deploy to"
        );
    }
    syncFirebaseRc(projectId);
    return projectId;
}

/**
 * Show what deploying would change, then deploy once that is agreed to.
 *
 * @returns {Promise<void>} Resolves once the rules are deployed, or once the
 *     run is abandoned because nothing changed or consent was withheld.
 * @throws {Error} When a step fails, or when there is no terminal to ask.
 */
async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            [
                "Usage:",
                "  npm run deploy:rules                 diff the live rules, confirm, then deploy",
                "  npm run deploy:rules -- --no-check   deploy without the diff and the prompt",
            ].join("\n")
        );
        return;
    }

    const projectId = resolveProject();

    if (!options.noCheck) {
        const live = readLiveRules(projectId);
        const local = normalise(
            fs.readFileSync(rulesPath, "utf8"),
            "database.rules.json"
        );
        if (printDiff(live, local, projectId)) {
            console.log("Nothing to deploy.");
            return;
        }
        // Proceeding unasked is the one failure this script exists to prevent,
        // so an unattended run stops here rather than assuming a yes.
        if (!process.stdin.isTTY) {
            throw new Error(
                "no terminal to ask for confirmation; rerun with --no-check to deploy unattended"
            );
        }
        const agreed = await confirm(
            `\nApply these changes to ${projectId}? [y/N] `
        );
        if (!agreed) {
            console.log(`Left the live rules of ${projectId} as they are.`);
            return;
        }
    }

    run("npm", ["run", "test:firebase-rules"]);
    run(firebaseBin, ["deploy", "--only", "database"]);
}

module.exports = { diffLines, hunk, isYes, normalise, parseArgs, printDiff };

// Guarded so the helpers above can be required without deploying anything.
if (require.main === module) {
    main().catch((error) => {
        console.error(`${RED}ERROR:${NC} ${error.message}`);
        process.exit(1);
    });
}
