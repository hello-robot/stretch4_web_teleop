#!/usr/bin/env node
/**
 * Latency benchmark for the robot side of web teleop.
 *
 * Drives a headless Chromium operator (operator_harness.js) against whatever
 * robot peer is currently joined to the local signaling server, and measures:
 *
 *   video      camera publish -> frame presented in the operator's <video>
 *              (wall-clock stamp painted into each frame by mock_robot.py)
 *   telemetry  /joint_states publish -> validJointState on the data channel
 *   commands   data-channel send -> message arrives on the ROS topic
 *              (setJointVelocity -> /teleop/joint_vel, driveBase -> /teleop/cmd_vel)
 *   action     setRobotPose -> FollowJointTrajectory goal -> success reported back
 *   service    seedLocalization -> std_srvs/Trigger -> reply reported back
 *   resources  CPU and RSS of the robot-side processes while streaming
 *
 * Usage:
 *   node tools/latency/measure_latency.js --label before \
 *       --probe-log /tmp/probe.jsonl --robot-procs 'firefox|rosbridge|rosapi|start_robot_browser' \
 *       --out before.json
 *   node tools/latency/measure_latency.js --compare before.json after.json
 *
 * See tools/latency/README.md for bringing up the stack.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs(argv) {
    const args = {
        label: "run",
        out: null,
        probeLog: null,
        robotProcs: null,
        streamSeconds: 20,
        commandSeconds: 15,
        commandHz: 10,
        roundTrips: 30,
        url: "https://localhost",
        compare: null,
        parity: true,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--label") args.label = next();
        else if (a === "--out") args.out = next();
        else if (a === "--probe-log") args.probeLog = next();
        else if (a === "--robot-procs") args.robotProcs = new RegExp(next());
        else if (a === "--stream-seconds") args.streamSeconds = Number(next());
        else if (a === "--command-seconds")
            args.commandSeconds = Number(next());
        else if (a === "--command-hz") args.commandHz = Number(next());
        else if (a === "--round-trips") args.roundTrips = Number(next());
        else if (a === "--url") args.url = next();
        else if (a === "--compare") args.compare = [next(), next()];
        else if (a === "--no-parity") args.parity = false;
        else throw new Error(`unknown argument ${a}`);
    }
    return args;
}

// ------------------------------------------------------------------ stats

function summarize(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return { n: 0 };
    const q = (p) =>
        v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    return {
        n: v.length,
        mean: round(mean),
        p50: round(q(0.5)),
        p95: round(q(0.95)),
        min: round(v[0]),
        max: round(v[v.length - 1]),
    };
}

const round = (x, d = 1) =>
    x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d;

// ------------------------------------------------------------- resources

const CLK_TCK = 100;
const PAGE_SIZE = 4096;

function matchingPids(regex) {
    const pids = [];
    for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        try {
            const cmd = fs
                .readFileSync(`/proc/${name}/cmdline`, "utf8")
                .replace(/\0/g, " ");
            if (regex.test(cmd)) pids.push(Number(name));
        } catch {
            /* process exited */
        }
    }
    return pids;
}

function procTimes(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
        // PSS splits shared pages between the processes sharing them, so a
        // multi-process browser is not counted several times over.
        let rss;
        try {
            const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
            rss = Number(/^Pss:\s+(\d+) kB/m.exec(rollup)[1]) * 1024;
        } catch {
            rss =
                Number(
                    fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]
                ) * PAGE_SIZE;
        }
        return { ticks, rss };
    } catch {
        return null;
    }
}

/** Sample CPU% (sum over processes, 100 = one core) and RSS once a second. */
function startResourceSampler(regex) {
    if (!regex) return { stop: () => null };
    const samples = [];
    let prev = new Map();
    let prevT = Date.now();
    const take = () => {
        const now = Date.now();
        const pids = matchingPids(regex);
        const cur = new Map();
        let ticks = 0;
        let rss = 0;
        for (const pid of pids) {
            const t = procTimes(pid);
            if (!t) continue;
            cur.set(pid, t.ticks);
            if (prev.has(pid)) ticks += t.ticks - prev.get(pid);
            rss += t.rss;
        }
        const dt = (now - prevT) / 1000;
        if (prev.size > 0)
            samples.push({
                cpu: (100 * ticks) / CLK_TCK / dt,
                rssMB: rss / 1048576,
                procs: pids.length,
            });
        prev = cur;
        prevT = now;
    };
    take();
    const timer = setInterval(take, 1000);
    return {
        stop() {
            clearInterval(timer);
            return {
                cpuPercent: summarize(samples.map((s) => s.cpu)),
                rssMB: summarize(samples.map((s) => s.rssMB)),
                processes: samples.length
                    ? samples[samples.length - 1].procs
                    : 0,
            };
        },
    };
}

// ---------------------------------------------------------------- probe

function readProbe(file, sinceMs) {
    if (!file || !fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.t * 1000 >= sinceMs);
}

function pairCommands(sends, probe, topic, pick) {
    const arrivals = new Map();
    for (const r of probe) {
        if (r.topic !== topic) continue;
        const key = round(pick(r), 7);
        if (!arrivals.has(key)) arrivals.set(key, r.t * 1000);
    }
    const latencies = [];
    let lost = 0;
    for (const s of sends) {
        const t = arrivals.get(round(s.value, 7));
        if (t === undefined) lost += 1;
        else latencies.push(t - s.t);
    }
    return { ...summarize(latencies), sent: sends.length, lost };
}

// --------------------------------------------------------------- parity

/** One of every operator command the robot handles, in an order that exercises state. */
const PARITY_COMMANDS = [
    { type: "getStretchTool" },
    { type: "getMaxEeSpeed" },
    { type: "getRunStop" },
    { type: "getVoiceCapability" },
    { type: "getOccupancyGrid" },
    { type: "setCameraPerspective", perspective: "left" },
    { type: "setExpandedGripper", toggle: true },
    { type: "setRobotMode", modifier: "navigation" },
    { type: "incrementalMove", jointName: "lift_joint", increment: 0.05 },
    { type: "setRobotPose", pose: { lift_joint: 0.55 } },
    {
        type: "playbackPoses",
        poses: [{ lift_joint: 0.4 }, { lift_joint: 0.5 }],
    },
    { type: "stopTrajectory" },
    { type: "setJointVelocity", jointName: "lift_joint", velocity: 0.03 },
    { type: "setJointVelocity", jointName: "lift_joint", velocity: 0 },
    { type: "setTaskSpaceVelocity", linear_X: 0.01, linear_Y: 0, linear_Z: 0 },
    { type: "setTaskSpaceVelocity", linear_X: 0, linear_Y: 0, linear_Z: 0 },
    { type: "driveBase", modifier: { linVelX: 0.1, linVelY: 0, angVel: 0 } },
    { type: "driveBase", modifier: { linVelX: 0, linVelY: 0, angVel: 0 } },
    { type: "stopMoveBase" },
    { type: "homeTheRobot" },
    { type: "seedLocalization" },
    { type: "setRunStop", toggle: true },
    { type: "setRunStop", toggle: false },
    {
        type: "moveBase",
        pose: {
            position: { x: 1, y: 0, z: 0 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
    },
];

/** Reply as stable text: key order fixed, float noise rounded. */
function normalizeReply(message) {
    const canon = (v) => {
        if (Array.isArray(v)) return v.map(canon);
        if (v && typeof v === "object") {
            return Object.fromEntries(
                Object.keys(v)
                    .sort()
                    .map((k) => [k, canon(v[k])])
            );
        }
        return typeof v === "number" ? round(v, 4) : v;
    };
    return JSON.stringify(canon(message));
}

function printParity(a, b) {
    if (!a.parity || !b.parity) return;
    console.log(
        `\nBehaviour parity (${a.label} vs ${b.label}): replies on the data channel and calls into ROS per command`
    );
    let differences = 0;
    a.parity.forEach((pa, i) => {
        const pb = b.parity[i];
        const same =
            JSON.stringify(pa.replies) === JSON.stringify(pb?.replies) &&
            JSON.stringify(pa.ros) === JSON.stringify(pb?.ros);
        const label = JSON.stringify(pa.command);
        if (same) {
            console.log(`  same  ${label}`);
            return;
        }
        differences += 1;
        console.log(`  DIFF  ${label}`);
        for (const [name, p] of [
            [a.label, pa],
            [b.label, pb],
        ]) {
            console.log(
                `        ${name}: replies ${JSON.stringify(p?.replies)}`
            );
            console.log(
                `        ${" ".repeat(name.length)}  ros     ${JSON.stringify(p?.ros)}`
            );
        }
    });
    console.log(`  ${differences} of ${a.parity.length} commands differ`);
}

// ------------------------------------------------------------------ run

async function run(args) {
    const { chromium } = require("playwright");
    const harnessSource = fs.readFileSync(
        path.join(__dirname, "operator_harness.js"),
        "utf8"
    );
    const browser = await chromium.launch({
        headless: true,
        args: [
            "--autoplay-policy=no-user-gesture-required",
            "--ignore-certificate-errors",
        ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error") console.error("[operator]", m.text());
    });
    const harnessUrl = `${args.url}/__latency_harness__`;
    await page.route(harnessUrl, (route) =>
        route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><meta charset="utf-8"><body>
<script src="/socket.io/socket.io.js"></script>
<script>${harnessSource}</script></body>`,
        })
    );

    const result = {
        label: args.label,
        date: new Date().toISOString(),
        host: os.hostname(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
    };
    try {
        await page.goto(harnessUrl);
        console.log(`[${args.label}] connecting as operator...`);
        result.connect = await page.evaluate(() =>
            window.harness.connect(90000)
        );
        console.log(
            `[${args.label}] connected in ${round(result.connect.connectMs)} ms; warming up`
        );
        await page.waitForTimeout(5000);

        console.log(`[${args.label}] streaming for ${args.streamSeconds}s`);
        const sampler = startResourceSampler(args.robotProcs);
        const streams = await page.evaluate(
            (ms) => window.harness.recordStreams(ms),
            args.streamSeconds * 1000
        );
        result.resources = sampler.stop();
        result.video = {};
        for (const [name, s] of Object.entries(streams.streams)) {
            result.video[name] = {
                latencyMs: summarize(s.latencies),
                fps: round(s.fps),
                resolution: `${s.width}x${s.height}`,
                kbps: round(s.kbps, 0),
                codec: s.codec,
                jitterBufferMs: round(s.jitterBufferMs),
                decodeErrors: s.decodeErrors,
            };
        }
        result.audio = {
            track: streams.audio.track,
            kbps: round(streams.audio.kbps, 0),
        };
        result.telemetryMs = summarize(streams.telemetry);
        result.telemetryHz = round(streams.telemetry.length / streams.elapsed);

        result.commands = {};
        for (const [kind, topic, pick, base] of [
            ["jointVelocity", "/teleop/joint_vel", (r) => r.value[0], 0.02],
            ["driveBase", "/teleop/cmd_vel", (r) => r.value[3], 0.03],
        ]) {
            console.log(
                `[${args.label}] ${kind} commands at ${args.commandHz} Hz for ${args.commandSeconds}s`
            );
            const since = Date.now() - 1000;
            const sends = await page.evaluate(
                ([k, hz, ms, b]) => window.harness.streamCommands(k, hz, ms, b),
                [kind, args.commandHz, args.commandSeconds * 1000, base]
            );
            await page.waitForTimeout(1500);
            // The first command pays for the one-off switch to velocity mode; report it apart.
            const probe = readProbe(args.probeLog, since);
            const all = pairCommands(sends, probe, topic, pick);
            const steady = pairCommands(sends.slice(1), probe, topic, pick);
            const first = pairCommands(sends.slice(0, 1), probe, topic, pick);
            result.commands[kind] = {
                ...steady,
                firstMs: first.p50 ?? null,
                lostIncludingFirst: all.lost,
            };
        }

        for (const kind of ["action", "service"]) {
            console.log(
                `[${args.label}] ${args.roundTrips} ${kind} round trips`
            );
            const { rtts, timeouts } = await page.evaluate(
                ([k, n]) => window.harness.roundTrips(k, n),
                [kind, args.roundTrips]
            );
            result[`${kind}RttMs`] = { ...summarize(rtts), timeouts };
        }
        if (args.parity) {
            console.log(
                `[${args.label}] parity script (${PARITY_COMMANDS.length} commands)`
            );
            const since = Date.now() - 1000;
            const windows = await page.evaluate(
                ([cmds, ms]) => window.harness.parity(cmds, ms),
                [PARITY_COMMANDS, 1500]
            );
            await page.waitForTimeout(500);
            const probe = readProbe(args.probeLog, since);
            result.parity = windows.map((w) => ({
                command: w.command,
                replies: w.replies.map(normalizeReply).sort(),
                ros: probe
                    .filter((r) => r.t * 1000 >= w.t0 && r.t * 1000 < w.t1)
                    .map((r) => `${r.topic} ${JSON.stringify(r.value)}`)
                    // Concurrent service calls may land in either order.
                    .sort(),
            }));
        }
        result.messageCounts = await page.evaluate(
            () => window.harness.state.messageCounts
        );
    } catch (error) {
        result.error = String(error);
        result.harnessLog = await page
            .evaluate(() => window.harness?.log?.() ?? [])
            .catch(() => []);
        console.error(`[${args.label}] FAILED:`, error);
    } finally {
        await page.evaluate(() => window.harness?.disconnect()).catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        await browser.close();
    }

    if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    printReport([result]);
    return result.error ? 1 : 0;
}

// --------------------------------------------------------------- report

function rows(r) {
    const v = (name, key) => r.video?.[name]?.[key];
    const lat = (s) => (s && s.n ? `${s.p50} / ${s.p95}` : "n/a");
    return [
        [
            "Overhead video latency p50 / p95 (ms)",
            lat(v("overhead", "latencyMs")),
        ],
        [
            "Gripper video latency p50 / p95 (ms)",
            lat(v("gripper", "latencyMs")),
        ],
        ["Overhead fresh frames/s", v("overhead", "fps")],
        ["Gripper fresh frames/s", v("gripper", "fps")],
        [
            "Overhead resolution / codec",
            `${v("overhead", "resolution")} ${v("overhead", "codec") ?? ""}`,
        ],
        [
            "Gripper resolution / codec",
            `${v("gripper", "resolution")} ${v("gripper", "codec") ?? ""}`,
        ],
        [
            "Video bitrate overhead + gripper (kbps)",
            (v("overhead", "kbps") ?? 0) + (v("gripper", "kbps") ?? 0),
        ],
        [
            "Robot audio track / bitrate (kbps)",
            r.audio?.track ? `${r.audio.track} / ${r.audio.kbps}` : "none",
        ],
        ["Telemetry latency p50 / p95 (ms)", lat(r.telemetryMs)],
        ["Telemetry rate (Hz)", r.telemetryHz],
        [
            "Joint velocity cmd latency p50 / p95 (ms)",
            lat(r.commands?.jointVelocity),
        ],
        [
            "Base velocity cmd latency p50 / p95 (ms)",
            lat(r.commands?.driveBase),
        ],
        [
            "Commands lost (joint / base)",
            `${r.commands?.jointVelocity?.lost ?? "?"} / ${r.commands?.driveBase?.lost ?? "?"}`,
        ],
        ["Trajectory action RTT p50 / p95 (ms)", lat(r.actionRttMs)],
        ["Trigger service RTT p50 / p95 (ms)", lat(r.serviceRttMs)],
        ["Robot-side CPU mean (% of one core)", r.resources?.cpuPercent?.mean],
        ["Robot-side memory, PSS mean (MB)", r.resources?.rssMB?.mean],
        ["Robot-side processes", r.resources?.processes],
        ["Operator connect time (ms)", round(r.connect?.connectMs)],
    ];
}

function printReport(results) {
    const table = results.map(rows);
    const labelWidth = Math.max(...table[0].map((row) => row[0].length));
    const colWidth = 22;
    const header =
        "Metric".padEnd(labelWidth) +
        results.map((r) => ` | ${String(r.label).padEnd(colWidth)}`).join("");
    console.log("\n" + header);
    console.log("-".repeat(header.length));
    table[0].forEach((row, i) => {
        console.log(
            row[0].padEnd(labelWidth) +
                table
                    .map(
                        (t) => ` | ${String(t[i][1] ?? "n/a").padEnd(colWidth)}`
                    )
                    .join("")
        );
    });
    for (const r of results)
        if (r.error) console.log(`\n${r.label}: ERROR ${r.error}`);
}

if (require.main === module) {
    const args = parseArgs(process.argv);
    if (args.compare) {
        const results = args.compare.map((f) =>
            JSON.parse(fs.readFileSync(f, "utf8"))
        );
        printReport(results);
        printParity(results[0], results[1]);
    } else {
        run(args).then((code) => process.exit(code));
    }
}

module.exports = { summarize };
