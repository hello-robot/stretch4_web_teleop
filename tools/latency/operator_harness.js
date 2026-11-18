/*
 * Minimal operator for the latency benchmark. Injected into a headless
 * Chromium page at https://localhost so socket.io signaling is same-origin.
 *
 * It speaks exactly the protocol the real operator page speaks (see
 * src/shared/webrtcconnections.tsx and src/shared/signaling/LocalSignaling.ts),
 * so the robot side under test cannot tell the difference. It skips all UI and
 * just records timings.
 *
 * Exposes window.harness for measure_latency.js to drive through page.evaluate.
 */
/* global io */ // socket.io client, loaded by the page from /socket.io/socket.io.js
(() => {
    const BARCODE_CELLS = 32;
    const BARCODE_BAND_FRACTION = 0.06;
    const SAMPLE_WIDTH = BARCODE_CELLS * 8;
    const SAMPLE_HEIGHT = 8;

    const wallNow = () => performance.timeOrigin + performance.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const state = {
        socket: null,
        pc: null,
        channel: null,
        cameraInfo: {},
        pendingCandidates: [],
        streams: {}, // name -> { video, samples: [], lastStamp, decodeErrors }
        telemetry: [], // ms latencies of validJointState
        recordVideo: false,
        recordTelemetry: false,
        waiters: [], // { predicate, resolve }
        messageCounts: {},
        log: [],
    };

    function log(...args) {
        const line = args
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" ");
        state.log.push(`${new Date().toISOString()} ${line}`);
    }

    // ---------------------------------------------------------------- video

    function decodeStamp(ctx) {
        const { data } = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
        let word = 0;
        const cell = SAMPLE_WIDTH / BARCODE_CELLS;
        const y = Math.floor(SAMPLE_HEIGHT / 2);
        for (let i = 0; i < BARCODE_CELLS; i++) {
            const x = Math.floor(i * cell + cell / 2);
            let sum = 0;
            for (let dx = -1; dx <= 1; dx++) {
                const o = (y * SAMPLE_WIDTH + x + dx) * 4;
                sum += (data[o] + data[o + 1] + data[o + 2]) / 3;
            }
            const bit = sum / 3 > 128 ? 1 : 0;
            word = word * 2 + bit;
        }
        const value = Math.floor(word / 256);
        const check = word % 256;
        if (((value ^ (value >> 8) ^ (value >> 16)) & 0xff) !== check)
            return null;
        return value;
    }

    function watchVideo(name, stream) {
        const video = document.createElement("video");
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        document.body.appendChild(video);
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_WIDTH;
        canvas.height = SAMPLE_HEIGHT;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const entry = {
            video,
            samples: [],
            lastStamp: null,
            decodeErrors: 0,
            presented: 0,
            width: 0,
            height: 0,
        };
        state.streams[name] = entry;

        const onFrame = (_now, meta) => {
            const t = wallNow();
            entry.width = meta.width;
            entry.height = meta.height;
            entry.presented += 1;
            const bandHeight = Math.max(
                1,
                Math.floor(video.videoHeight * BARCODE_BAND_FRACTION * 0.5)
            );
            ctx.drawImage(
                video,
                0,
                0,
                video.videoWidth,
                bandHeight,
                0,
                0,
                SAMPLE_WIDTH,
                SAMPLE_HEIGHT
            );
            const stamp = decodeStamp(ctx);
            if (stamp === null) {
                entry.decodeErrors += 1;
            } else if (stamp !== entry.lastStamp) {
                entry.lastStamp = stamp;
                if (state.recordVideo) {
                    // Both stamps are wall-clock ms folded to 24 bits.
                    let latency = (Math.floor(t) & 0xffffff) - stamp;
                    if (latency < -0x800000) latency += 0x1000000;
                    entry.samples.push({ t, latency: latency + (t % 1) });
                }
            }
            video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        video.play().catch((e) => log("video play failed", String(e)));
    }

    // ------------------------------------------------------------- messages

    function onMessage(obj) {
        const messages = Array.isArray(obj) ? obj : [obj];
        const t = wallNow();
        for (const message of messages) {
            if (!message || typeof message !== "object") continue;
            state.messageCounts[message.type] =
                (state.messageCounts[message.type] || 0) + 1;
            if (message.type === "validJointState" && state.recordTelemetry) {
                const probe = message.robotPose?.latency_probe;
                if (typeof probe === "number") {
                    let latency = ((t / 1000) % 100000) - probe;
                    if (latency < -50000) latency += 100000;
                    state.telemetry.push(latency * 1000);
                }
            }
            for (const waiter of [...state.waiters]) {
                if (waiter.predicate(message)) {
                    state.waiters.splice(state.waiters.indexOf(waiter), 1);
                    waiter.resolve({ t, message });
                }
            }
        }
    }

    function waitForMessage(predicate, timeoutMs) {
        return new Promise((resolve) => {
            const waiter = { predicate, resolve };
            state.waiters.push(waiter);
            setTimeout(() => {
                const i = state.waiters.indexOf(waiter);
                if (i >= 0) {
                    state.waiters.splice(i, 1);
                    resolve(null);
                }
            }, timeoutMs);
        });
    }

    function send(obj) {
        if (!state.channel || state.channel.readyState !== "open") return false;
        state.channel.send(JSON.stringify(obj));
        return true;
    }

    // -------------------------------------------------------------- webrtc

    function createPeer() {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
        });
        state.pc = pc;
        pc.onicecandidate = (event) => {
            state.socket.emit("signalling", { candidate: event.candidate });
        };
        pc.ontrack = (event) => {
            const stream = event.streams[0];
            const name = state.cameraInfo[stream.id];
            log("track", event.track.kind, name, stream.id);
            if (event.track.kind === "audio")
                state.audioTrack = name || "unlabeled";
            if (event.track.kind === "video" && name && !state.streams[name]) {
                watchVideo(name, stream);
            }
        };
        pc.ondatachannel = (event) => {
            if (event.channel.label !== "messages") return;
            state.channel = event.channel;
            event.channel.onmessage = (e) => {
                try {
                    onMessage(JSON.parse(e.data));
                } catch (err) {
                    log("bad message", String(err));
                }
            };
            event.channel.onopen = () => log("data channel open");
        };
        pc.onconnectionstatechange = () => log("pc", pc.connectionState);
    }

    async function onSignal(message) {
        const { candidate, sessionDescription, cameraInfo } = message;
        if (cameraInfo && Object.keys(cameraInfo).length)
            state.cameraInfo = { ...cameraInfo };
        const pc = state.pc;
        if (sessionDescription) {
            await pc.setRemoteDescription(sessionDescription);
            for (const c of state.pendingCandidates)
                await pc.addIceCandidate(c).catch(() => {});
            state.pendingCandidates = [];
            if (sessionDescription.type === "offer") {
                await pc.setLocalDescription();
                state.socket.emit("signalling", {
                    sessionDescription: pc.localDescription,
                });
            }
        } else if (candidate !== undefined) {
            if (!pc.remoteDescription) state.pendingCandidates.push(candidate);
            else await pc.addIceCandidate(candidate).catch(() => {});
        }
    }

    async function connect(timeoutMs = 60000) {
        const t0 = wallNow();
        createPeer();
        state.socket = io();
        state.socket.on("signalling", (m) =>
            onSignal(m).catch((e) => log("signal error", String(e)))
        );
        state.socket.on("bye", () => log("robot said bye"));
        await new Promise((r) => state.socket.on("connect", r));
        const sessionId = crypto.randomUUID();
        let joined = false;
        while (!joined && wallNow() - t0 < timeoutMs) {
            joined = await new Promise((r) =>
                state.socket.emit("join_as_operator", sessionId, (res) =>
                    r(res.success)
                )
            );
            if (!joined) await sleep(1000);
        }
        if (!joined) throw new Error("could not join as operator");
        const tJoined = wallNow();
        while (wallNow() - t0 < timeoutMs) {
            const ready =
                state.channel?.readyState === "open" &&
                state.streams.overhead?.presented > 0 &&
                state.streams.gripper?.presented > 0;
            if (ready) break;
            await sleep(50);
        }
        if (state.channel?.readyState !== "open")
            throw new Error("data channel never opened");
        return { connectMs: wallNow() - tJoined };
    }

    // --------------------------------------------------------------- phases

    async function recordStreams(durationMs) {
        for (const entry of Object.values(state.streams)) {
            entry.samples = [];
            entry.decodeErrors = 0;
            entry.presented = 0;
        }
        state.telemetry = [];
        const statsBefore = await inboundStats();
        state.recordVideo = true;
        state.recordTelemetry = true;
        const t0 = wallNow();
        await sleep(durationMs);
        state.recordVideo = false;
        state.recordTelemetry = false;
        const elapsed = (wallNow() - t0) / 1000;
        const statsAfter = await inboundStats();
        const streams = {};
        for (const [name, entry] of Object.entries(state.streams)) {
            const before = statsBefore[name] || {};
            const after = statsAfter[name] || {};
            streams[name] = {
                latencies: entry.samples.map((s) => s.latency),
                uniqueFrames: entry.samples.length,
                fps: entry.samples.length / elapsed,
                presented: entry.presented,
                decodeErrors: entry.decodeErrors,
                width: entry.width,
                height: entry.height,
                kbps:
                    after.bytesReceived !== undefined
                        ? ((after.bytesReceived - before.bytesReceived) * 8) /
                          1000 /
                          elapsed
                        : null,
                codec: after.codec || null,
                jitterBufferMs: after.jitterBufferEmittedCount
                    ? (1000 *
                          (after.jitterBufferDelay -
                              (before.jitterBufferDelay || 0))) /
                      (after.jitterBufferEmittedCount -
                          (before.jitterBufferEmittedCount || 0))
                    : null,
            };
        }
        const audioKbps =
            statsAfter.__audio !== undefined &&
            statsBefore.__audio !== undefined
                ? ((statsAfter.__audio - statsBefore.__audio) * 8) /
                  1000 /
                  elapsed
                : null;
        return {
            elapsed,
            streams,
            telemetry: state.telemetry.slice(),
            audio: { track: state.audioTrack || null, kbps: audioKbps },
        };
    }

    async function inboundStats() {
        const out = {};
        if (!state.pc) return out;
        const stats = await state.pc.getStats();
        const codecs = {};
        stats.forEach((r) => {
            if (r.type === "codec") codecs[r.id] = r.mimeType;
        });
        stats.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio")
                out.__audio = r.bytesReceived;
            if (r.type !== "inbound-rtp" || r.kind !== "video") return;
            for (const [name, entry] of Object.entries(state.streams)) {
                const track = entry.video.srcObject?.getVideoTracks()[0];
                if (track && r.trackIdentifier === track.id) {
                    out[name] = {
                        bytesReceived: r.bytesReceived,
                        codec: codecs[r.codecId] || null,
                        jitterBufferDelay: r.jitterBufferDelay,
                        jitterBufferEmittedCount: r.jitterBufferEmittedCount,
                    };
                }
            }
        });
        return out;
    }

    /**
     * Stream velocity commands at `hz` for `durationMs`. Each command carries a
     * unique value so the ROS-side probe can pair it with its send time.
     */
    async function streamCommands(kind, hz, durationMs, base) {
        const sends = [];
        const count = Math.round((hz * durationMs) / 1000);
        for (let i = 0; i < count; i++) {
            const value = Math.round((base + i * 1e-4) * 1e7) / 1e7;
            let message;
            if (kind === "jointVelocity") {
                message = {
                    type: "setJointVelocity",
                    jointName: "lift_joint",
                    velocity: value,
                };
            } else if (kind === "driveBase") {
                message = {
                    type: "driveBase",
                    modifier: { linVelX: 0, linVelY: 0, angVel: value },
                };
            } else {
                throw new Error(`unknown kind ${kind}`);
            }
            const t = wallNow();
            if (send(message)) sends.push({ value, t });
            await sleep(1000 / hz);
        }
        // Leave the robot stopped.
        if (kind === "jointVelocity")
            send({
                type: "setJointVelocity",
                jointName: "lift_joint",
                velocity: 0,
            });
        else
            send({
                type: "driveBase",
                modifier: { linVelX: 0, linVelY: 0, angVel: 0 },
            });
        return sends;
    }

    /** Request/response round trips through the robot: action goal or service. */
    async function roundTrips(kind, count, timeoutMs = 5000) {
        const rtts = [];
        let timeouts = 0;
        for (let i = 0; i < count; i++) {
            let request;
            let predicate;
            if (kind === "action") {
                request = {
                    type: "setRobotPose",
                    pose: { lift_joint: i % 2 ? 0.6 : 0.5 },
                };
                predicate = (m) =>
                    m.type === "playbackPosesState" &&
                    m.message?.state === "movement successful!";
            } else if (kind === "service") {
                request = { type: "seedLocalization" };
                predicate = (m) => m.type === "seedLocalizationState";
            } else {
                throw new Error(`unknown kind ${kind}`);
            }
            const waiting = waitForMessage(predicate, timeoutMs);
            const t0 = wallNow();
            send(request);
            const reply = await waiting;
            if (reply) rtts.push(reply.t - t0);
            else timeouts += 1;
            await sleep(100);
        }
        return { rtts, timeouts };
    }

    /**
     * Message types the robot sends on its own schedule rather than in reply.
     * occupancyGridUnavailable is here because after a miss the robot retries
     * the map every 2 s for 20 s, so it lands in whichever window is open.
     */
    const PERIODIC = new Set([
        "validJointState",
        "odom",
        "batteryState",
        "mode",
        "isRunStopped",
        "isHomed",
        "leaseStatus",
        "occupancyGridUnavailable",
    ]);

    /**
     * Send each command and record every non-periodic reply in the window
     * after it, for comparing two robot implementations' behaviour.
     */
    async function parity(commands, windowMs) {
        const out = [];
        for (const command of commands) {
            const replies = [];
            const waiter = {
                predicate: (m) => {
                    if (!PERIODIC.has(m.type)) replies.push(m);
                    return false;
                },
                resolve: () => {},
            };
            state.waiters.push(waiter);
            const t0 = wallNow();
            send(command);
            await sleep(windowMs);
            state.waiters.splice(state.waiters.indexOf(waiter), 1);
            out.push({ command, t0, t1: wallNow(), replies });
        }
        return out;
    }

    function disconnect() {
        try {
            state.socket?.emit("bye", "operator");
        } catch {
            /* ignore */
        }
        state.pc?.close();
    }

    window.harness = {
        connect,
        recordStreams,
        streamCommands,
        roundTrips,
        parity,
        disconnect,
        send,
        state,
        log: () => state.log.slice(),
    };
})();
