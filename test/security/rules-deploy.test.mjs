/**
 * The diff and the prompt that stand in front of a database rules deploy.
 *
 * A rules deploy replaces the entire live ruleset rather than patching it, so
 * a repository copy that has fallen behind silently reverts whatever it is
 * missing. deployRules.js answers that by pulling the live rules, printing a
 * diff and waiting for a yes -- which only protects anything if the diff is
 * right and the prompt is strict.
 *
 * firebase-database-rules.test.mjs checks what the rules allow once deployed.
 * This file checks the gate in front of deploying them, with no emulator and
 * no project: every function here is pure, which is why deployRules.js exports
 * them behind a require.main guard.
 *
 * Run through `npm run test:rules:deploy`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, suite, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
);

const { diffLines, hunk, isYes, normalise, parseArgs, printDiff } = require(
    "../../scripts/deployRules",
);

/** Context the script pads a hunk with, matching DIFF_CONTEXT. */
const CONTEXT = 3;

/** Environment key npm exports when `--no-check` is passed without `--`. */
const NPM_CONFIG_CHECK = "npm_config_check";

let savedCheck;
let printed;
let realLog;

/**
 * The marks of a diff as one string, for comparing a whole result at once.
 *
 * @param {{mark: string, text: string}[]} ops Diff operations.
 * @returns {string} One character per operation.
 */
const marks = (ops) => ops.map((op) => op.mark).join("");

/**
 * The lines on one side of a diff.
 *
 * @param {{mark: string, text: string}[]} ops Diff operations.
 * @param {string} mark Mark to collect.
 * @returns {string[]} The text of the operations carrying that mark.
 */
const linesMarked = (ops, mark) =>
    ops.filter((op) => op.mark === mark).map((op) => op.text);

beforeEach(() => {
    savedCheck = process.env[NPM_CONFIG_CHECK];
    delete process.env[NPM_CONFIG_CHECK];
    printed = [];
    realLog = console.log;
    // The script colours its output when it is on a terminal or in Actions.
    // The codes are stripped here so a case reads the text, not the palette.
    console.log = (...args) =>
        printed.push(
            args.join(" ").replace(/\u001b\[[0-9;]*m/g, ""),
        );
});

afterEach(() => {
    console.log = realLog;
    if (savedCheck === undefined) delete process.env[NPM_CONFIG_CHECK];
    else process.env[NPM_CONFIG_CHECK] = savedCheck;
});

suite("deployRules diffs and prompts by default unless --no-check is passed", () => {
    test("defaults to showing the diff and asking", () => {
        assert.deepEqual(parseArgs([]), { noCheck: false, help: false });
    });

    test("--no-check deploys without either", () => {
        assert.equal(parseArgs(["--no-check"]).noCheck, true);
    });

    test("honours the flag npm swallowed when -- was omitted", () => {
        // `npm run deploy:rules --no-check` never reaches argv: npm consumes
        // it and exports npm_config_check as an empty string. Reading only
        // argv there would prompt, which is the harmless direction -- but npm
        // has spelled the negation both ways, so both are read.
        for (const spelling of ["", "false"]) {
            process.env[NPM_CONFIG_CHECK] = spelling;
            assert.equal(parseArgs([]).noCheck, true, `npm_config_check=${spelling}`);
        }
    });

    test("an npm_config_check that is not a negation leaves the diff on", () => {
        process.env[NPM_CONFIG_CHECK] = "true";
        assert.equal(parseArgs([]).noCheck, false);
    });

    test("rejects --check with a message explaining that diffing is the default", () => {
        // Reject the flag explicitly so callers know to omit it or pass --no-check.
        assert.throws(() => parseArgs(["--check"]), /--check is now the default/);
    });

    test("--help is a request to print usage, not to deploy", () => {
        assert.equal(parseArgs(["--help"]).help, true);
        assert.equal(parseArgs(["-h"]).help, true);
    });

    test("refuses an argument it does not know", () => {
        assert.throws(() => parseArgs(["--force"]), {
            message: "unknown argument: --force",
        });
    });
});

suite("normalising rules ignores formatting and comments while preserving key order", () => {
    test("formatting and comments are not changes", () => {
        // The database returns the rules re-encoded, so indentation and the
        // comments in the repository copy never survive the round trip. If
        // they counted, every run would print a diff of the whole file.
        const live = normalise('{"rules":{".read":false}}', "live");
        const local = normalise(
            '{\n  "rules": {\n    ".read": false\n  }\n}\n',
            "local",
        );
        assert.deepEqual(live, local);
        assert.equal(printDiff(live, local, "demo-project"), true);
        assert.match(printed.join("\n"), /live rules match database\.rules\.json/);
    });

    test("key order is a change, because the database preserves it", () => {
        const live = normalise('{"a":1,"b":2}', "live");
        const local = normalise('{"b":2,"a":1}', "local");
        assert.notDeepEqual(live, local);
    });

    test("something that is not JSON says which side it came from", () => {
        assert.throws(
            () => normalise("{not json", "the live rules of demo-project"),
            /the live rules of demo-project is not valid JSON/,
        );
    });

    test("database.rules.json parses and normalises without error", () => {
        const text = fs.readFileSync(
            path.join(repoRoot, "database.rules.json"),
            "utf8",
        );
        const lines = normalise(text, "database.rules.json");
        assert.ok(lines.length > 1);
        assert.equal(printDiff(lines, lines, "demo-project"), true);
    });
});

suite("diffLines marks added, removed, and unchanged lines in order", () => {
    test("two identical files have nothing between them", () => {
        const ops = diffLines(["a", "b", "c"], ["a", "b", "c"]);
        assert.equal(marks(ops), "   ");
    });

    test("an added line is marked as added", () => {
        const ops = diffLines(["a", "c"], ["a", "b", "c"]);
        assert.deepEqual(linesMarked(ops, "+"), ["b"]);
        assert.deepEqual(linesMarked(ops, "-"), []);
    });

    test("a removed line is marked as removed", () => {
        const ops = diffLines(["a", "b", "c"], ["a", "c"]);
        assert.deepEqual(linesMarked(ops, "-"), ["b"]);
        assert.deepEqual(linesMarked(ops, "+"), []);
    });

    test("a changed line is both", () => {
        const ops = diffLines(["a", "b", "c"], ["a", "B", "c"]);
        assert.deepEqual(linesMarked(ops, "-"), ["b"]);
        assert.deepEqual(linesMarked(ops, "+"), ["B"]);
    });

    test("an empty side is wholly added or wholly removed", () => {
        assert.equal(marks(diffLines([], ["a", "b"])), "++");
        assert.equal(marks(diffLines(["a", "b"], [])), "--");
        assert.equal(marks(diffLines([], [])), "");
    });

    test("a common run between two changes is kept in order", () => {
        const ops = diffLines(["a", "x", "b"], ["a", "y", "b"]);
        assert.equal(ops[0].text, "a");
        assert.equal(ops.at(-1).text, "b");
        assert.deepEqual(linesMarked(ops, "-"), ["x"]);
        assert.deepEqual(linesMarked(ops, "+"), ["y"]);
    });
});

suite("hunk groups nearby changes with surrounding context lines", () => {
    /**
     * Lines numbered 1..n, so a hunk header can be read off the result.
     *
     * @param {number} count How many lines.
     * @returns {string[]} The lines.
     */
    const numbered = (count) =>
        Array.from({ length: count }, (_, index) => `line ${index + 1}`);

    test("an unchanged file prints no hunks at all", () => {
        assert.deepEqual(hunk(diffLines(numbered(20), numbered(20)), CONTEXT), []);
    });

    test("a change carries its context and says where it sits", () => {
        const before = numbered(20);
        const after = numbered(20);
        after[9] = "changed";
        const hunks = hunk(diffLines(before, after), CONTEXT);

        assert.equal(hunks.length, 1);
        const [entry] = hunks;
        // Line 10 changed, so the hunk runs 7..13 on both sides: three lines
        // of context, the removal and the addition, three lines of context.
        assert.equal(entry.beforeStart, 7);
        assert.equal(entry.afterStart, 7);
        assert.equal(entry.beforeCount, 7);
        assert.equal(entry.afterCount, 7);
        assert.deepEqual(linesMarked(entry.ops, "-"), ["line 10"]);
        assert.deepEqual(linesMarked(entry.ops, "+"), ["changed"]);
    });

    test("two changes far apart are two hunks", () => {
        const before = numbered(40);
        const after = numbered(40);
        after[4] = "first";
        after[34] = "second";
        const hunks = hunk(diffLines(before, after), CONTEXT);
        assert.equal(hunks.length, 2);
        assert.ok(hunks[0].beforeStart < hunks[1].beforeStart);
    });

    test("two changes close together are one", () => {
        // Their context overlaps, so printing them apart would repeat lines.
        const before = numbered(20);
        const after = numbered(20);
        after[9] = "first";
        after[11] = "second";
        assert.equal(hunk(diffLines(before, after), CONTEXT).length, 1);
    });

    test("a change at the top is not padded past the start of the file", () => {
        const before = numbered(10);
        const after = numbered(10);
        after[0] = "changed";
        const [entry] = hunk(diffLines(before, after), CONTEXT);
        assert.equal(entry.beforeStart, 1);
        assert.equal(entry.afterStart, 1);
    });

    test("a wholly new file is one hunk starting at nothing", () => {
        const [entry] = hunk(diffLines([], numbered(3)), CONTEXT);
        assert.equal(entry.beforeStart, 0);
        assert.equal(entry.beforeCount, 0);
        assert.equal(entry.afterCount, 3);
    });
});

suite("printDiff shows unified diff hunks and warns when enforced rules are removed", () => {
    test("prints unified diff headers, hunks, and added/removed line counts", () => {
        const live = normalise('{"rules":{".read":false}}', "live");
        const local = normalise('{"rules":{".read":true}}', "local");

        assert.equal(printDiff(live, local, "demo-project"), false);
        const output = printed.join("\n");
        assert.match(output, /^--- live/m);
        assert.match(output, /^\+\+\+ local/m);
        assert.match(output, /@@ -\d+,\d+ \+\d+,\d+ @@/);
        assert.match(output, /deploying would apply 1 added and 1 removed line\(s\)/);
    });

    test("removing a rule is called out as removing one", () => {
        // A removed line is a rule the project enforces today. Deploying is
        // how it stops being enforced, which is the case worth a sentence.
        const live = normalise('{"rules":{".read":false,".write":false}}', "live");
        const local = normalise('{"rules":{".read":false}}', "local");

        assert.equal(printDiff(live, local, "demo-project"), false);
        assert.match(
            printed.join("\n"),
            /Removed lines are rules the project enforces today/,
        );
    });

    test("a rule inserted between two others is not called out that way", () => {
        const live = normalise('{"a":{".read":false},"c":{".read":false}}', "live");
        const local = normalise(
            '{"a":{".read":false},"b":{".read":false},"c":{".read":false}}',
            "local",
        );

        assert.equal(printDiff(live, local, "demo-project"), false);
        const output = printed.join("\n");
        assert.match(output, /3 added and 0 removed/);
        assert.doesNotMatch(output, /enforces today/);
    });

    test("a rule appended at the end still reports a removed line", () => {
        // Not a fault in the diff: the rule before it gains a comma, so that
        // line really did change. Worth recording, because it is why a purely
        // additive change can report a removal and ask to be looked at.
        const live = normalise('{"rules":{".read":false}}', "live");
        const local = normalise('{"rules":{".read":false,".write":false}}', "local");

        assert.equal(printDiff(live, local, "demo-project"), false);
        const output = printed.join("\n");
        assert.match(output, /2 added and 1 removed/);
        assert.match(output, /enforces today/);
    });

    test("the project the rules came from is named in the header", () => {
        const live = normalise('{"rules":{".read":false}}', "live");
        const local = normalise('{"rules":{".read":true}}', "local");
        printDiff(live, local, "stretch4-web-interface");
        assert.match(printed.join("\n"), /stretch4-web-interface/);
    });
});

suite("only y or yes counts as consent to deploy rules", () => {
    test("y and yes are a yes, however they are typed", () => {
        for (const answer of ["y", "Y", "yes", "YES", " yes ", "Yes\n"]) {
            assert.equal(isYes(answer), true, `${JSON.stringify(answer)} is a yes`);
        }
    });

    test("everything else is a no, the empty answer included", () => {
        // A stray keypress or a closed stdin must leave the live rules alone.
        for (const answer of ["", " ", "n", "no", "ya", "yep", "sure", "1", "ok"]) {
            assert.equal(isYes(answer), false, `${JSON.stringify(answer)} is not a yes`);
        }
    });

    test("no answer at all is a no", () => {
        assert.equal(isYes(undefined), false);
        assert.equal(isYes(null), false);
    });
});
