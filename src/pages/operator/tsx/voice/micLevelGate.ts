/**
 * This file implements the microphone level gate
 * for the voice command assistant.
 */

import {
    VOICE_MIC_GATE_HANG_MS,
    VOICE_MIC_GATE_LOOKBACK_MS,
    VOICE_MIC_GATE_POLL_MS,
    VOICE_MIC_RMS_THRESHOLD,
    VOICE_UPLINK_RING_MS,
} from "./constants";

export type MicLevelGateOptions = {
    rmsThreshold?: number;
    hangMs?: number;
    lookbackMs?: number;
    pollIntervalMs?: number;
    /** When true, uplink transmits even if RMS gate is closed (e.g. asleep wake listening). */
    bypassGate?: () => boolean;
    /** level = RMS (always); gateOpen = volume threshold met (not force-closed state). */
    onGateChange?: (gateOpen: boolean, level: number) => void;
    /**
     * When true, keep a ~15s pre-gate mic ring for VAD-segmented Opus clips.
     * Off by default (--log-svc / logSvc from join_as_operator).
     */
    recordUplink?: boolean;
};

/** Absolute sample index into the uplink ring (with lookback already applied). */
export type UplinkRingMark = {
    absoluteSample: number;
};

export type MicLevelGate = {
    readonly transmitStream: MediaStream;
    readonly sampleRate: number;
    readonly currentLevel: number;
    readonly gateOpen: boolean;
    readonly forceClosed: boolean;
    setForceClosed: (closed: boolean) => void;
    resumeAfterForceClose: () => void;
    /**
     * Resume a suspended/interrupted AudioContext (common after iOS background).
     * @returns true when the context is running afterward.
     */
    resume: () => Promise<boolean>;
    /**
     * Cheap check: context running + input track live and unmuted.
     * Not enough alone on iOS PWA — the graph can look fine and still be silent.
     */
    isHealthy: () => boolean;
    /**
     * True once ScriptProcessor has fired at least once (or false on timeout).
     * Use after resume(); `isHealthy` can pass while the graph is still dead.
     */
    probeActivity: (timeoutMs?: number) => Promise<boolean>;
    /**
     * Mark uplink ring cursor with lookback (no-op when recording is off).
     * Pass result to `copyUplinkSince` on speech_stopped.
     */
    markUplink: (lookbackMs: number) => UplinkRingMark | null;
    /** Copy pre-gate mic samples from mark → now (empty when recording off). */
    copyUplinkSince: (mark: UplinkRingMark) => Float32Array;
    /** Copy the most recent N ms of pre-gate mic (empty when recording off). */
    copyUplinkRecent: (ms: number) => Float32Array;
    stop: () => void;
};

/** How long `probeActivity` waits for a ScriptProcessor callback. */
const MIC_ACTIVITY_PROBE_MS = 400;

/**
 * Size of the buffer that the script processor will use to process the audio.
 */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

function computeRms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
        const s = buffer[i] ?? 0;
        sum += s * s;
    }
    return Math.sqrt(sum / buffer.length);
}

/**
 * Pre-gate mic ring. Capacity is lookback-only, or ~15s when recording clips.
 * Tracks absolute sample counts so speech_started can mark a cursor.
 */
class PreGateAudioRing {
    private readonly buffer: Float32Array;
    private writePos = 0;
    private filled = 0;
    /** Total samples ever pushed (monotonic). */
    private totalPushed = 0;

    constructor(sampleRate: number, capacityMs: number) {
        const capacity = Math.max(
            1,
            Math.ceil((sampleRate * capacityMs) / 1000),
        );
        this.buffer = new Float32Array(capacity);
    }

    push(samples: Float32Array) {
        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writePos] = samples[i] ?? 0;
            this.writePos = (this.writePos + 1) % this.buffer.length;
            this.filled = Math.min(this.filled + 1, this.buffer.length);
            this.totalPushed += 1;
        }
    }

    mark(lookbackSamples: number): UplinkRingMark {
        return {
            absoluteSample: Math.max(0, this.totalPushed - lookbackSamples),
        };
    }

    copyFromMark(mark: UplinkRingMark): Float32Array {
        const oldestAbsolute = this.totalPushed - this.filled;
        const startAbs = Math.max(mark.absoluteSample, oldestAbsolute);
        const count = Math.max(0, this.totalPushed - startAbs);
        if (count === 0) {
            return new Float32Array(0);
        }
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const absolute = startAbs + i;
            const age = this.totalPushed - absolute;
            const idx =
                (this.writePos - age + this.buffer.length) % this.buffer.length;
            out[i] = this.buffer[idx] ?? 0;
        }
        return out;
    }

    copyRecent(sampleCount: number): Float32Array {
        const n = Math.min(Math.max(0, sampleCount), this.filled);
        return this.copyFromMark({
            absoluteSample: this.totalPushed - n,
        });
    }
}

/**
 * RMS volume gate: meters from the live input track; uplink is gated via GainNode
 * (input track stays enabled so the analyser always sees real audio).
 * Opens instantly on threshold; flushes a short lookback so onset is not clipped.
 */
export async function createMicLevelGate(
    stream: MediaStream,
    opts: MicLevelGateOptions,
): Promise<MicLevelGate> {
    const rmsThreshold = opts.rmsThreshold ?? VOICE_MIC_RMS_THRESHOLD;
    const hangMs = opts.hangMs ?? VOICE_MIC_GATE_HANG_MS;
    const lookbackMs = opts.lookbackMs ?? VOICE_MIC_GATE_LOOKBACK_MS;
    const pollMs = opts.pollIntervalMs ?? VOICE_MIC_GATE_POLL_MS;
    const recordUplink = Boolean(opts.recordUplink);

    const audioContext = new AudioContext();
    await audioContext.resume();

    const sampleRate = audioContext.sampleRate;
    const ring = new PreGateAudioRing(
        sampleRate,
        recordUplink ? VOICE_UPLINK_RING_MS : lookbackMs,
    );

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const processor = audioContext.createScriptProcessor(
        SCRIPT_PROCESSOR_BUFFER_SIZE,
        1,
        1,
    );
    source.connect(processor);

    const liveGain = audioContext.createGain();
    liveGain.gain.value = 0;
    processor.connect(liveGain);

    const destination = audioContext.createMediaStreamDestination();
    liveGain.connect(destination);

    const transmitStream = destination.stream;

    const rmsBuffer = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    );
    let currentLevel = 0;
    let gateOpen = false;
    let forceClosed = false;
    let belowThresholdSince: number | null = null;
    let flushing = false;
    let flushSource: AudioBufferSourceNode | null = null;
    /** Bumps on every `onaudioprocess` — `probeActivity` watches this advance. */
    let processGeneration = 0;
    let stopped = false;

    processor.onaudioprocess = (event) => {
        processGeneration += 1;
        const input = event.inputBuffer.getChannelData(0);
        ring.push(input);
        event.outputBuffer.getChannelData(0).set(input);
    };

    const stopFlushSource = () => {
        if (!flushSource) {
            return;
        }
        try {
            flushSource.stop();
        } catch {
            //
        }
        flushSource.disconnect();
        flushSource = null;
        flushing = false;
    };

    const applyLiveGain = () => {
        const bypass = opts.bypassGate?.() ?? false;
        const shouldTransmit =
            !forceClosed && !flushing && (gateOpen || bypass);
        liveGain.gain.value = shouldTransmit ? 1 : 0;
        // UI glow/waveform follows RMS threshold only — bypass is uplink-only
        // (e.g. asleep wake listening) and must not look like the gate is open.
        opts.onGateChange?.(gateOpen, currentLevel);
    };

    const flushLookback = () => {
        if (flushing || forceClosed || (opts.bypassGate?.() ?? false)) {
            return;
        }
        const samples = ring.copyRecent(
            Math.ceil((sampleRate * lookbackMs) / 1000),
        );
        if (samples.length === 0) {
            return;
        }

        stopFlushSource();
        flushing = true;
        applyLiveGain();

        const audioBuffer = audioContext.createBuffer(
            1,
            samples.length,
            sampleRate,
        );
        audioBuffer.getChannelData(0).set(samples);

        flushSource = audioContext.createBufferSource();
        flushSource.buffer = audioBuffer;
        flushSource.connect(destination);
        flushSource.onended = () => {
            if (flushSource) {
                flushSource.disconnect();
                flushSource = null;
            }
            flushing = false;
            applyLiveGain();
        };
        flushSource.start();
    };

    const tick = () => {
        currentLevel = computeRms(analyser, rmsBuffer);

        if (forceClosed) {
            if (gateOpen) {
                gateOpen = false;
            }
            belowThresholdSince = null;
            applyLiveGain();
            return;
        }

        const now = performance.now();
        if (currentLevel >= rmsThreshold) {
            belowThresholdSince = null;
            if (!gateOpen) {
                gateOpen = true;
                flushLookback();
            }
        } else if (gateOpen) {
            if (belowThresholdSince === null) {
                belowThresholdSince = now;
            } else if (now - belowThresholdSince >= hangMs) {
                gateOpen = false;
                belowThresholdSince = null;
            }
        } else {
            belowThresholdSince = null;
        }

        applyLiveGain();
    };

    applyLiveGain();
    const pollTimer = window.setInterval(tick, pollMs);

    const inputTracksLive = () =>
        stream.getAudioTracks().some(
            (t) => t.readyState === "live" && !t.muted,
        );

    return {
        transmitStream,
        sampleRate,
        get currentLevel() {
            return currentLevel;
        },
        get gateOpen() {
            return gateOpen;
        },
        get forceClosed() {
            return forceClosed;
        },
        setForceClosed(closed: boolean) {
            forceClosed = closed;
            if (closed) {
                gateOpen = false;
                belowThresholdSince = null;
                stopFlushSource();
            }
            applyLiveGain();
        },
        resumeAfterForceClose() {
            forceClosed = false;
            applyLiveGain();
        },
        async resume() {
            if (audioContext.state === "closed") {
                return false;
            }
            if (audioContext.state !== "running") {
                try {
                    await audioContext.resume();
                } catch {
                    return false;
                }
            }
            return audioContext.state === "running";
        },
        isHealthy() {
            return audioContext.state === "running" && inputTracksLive();
        },
        probeActivity(timeoutMs = MIC_ACTIVITY_PROBE_MS) {
            if (stopped || audioContext.state === "closed") {
                return Promise.resolve(false);
            }
            if (!inputTracksLive()) {
                return Promise.resolve(false);
            }
            const startGen = processGeneration;
            const deadline = performance.now() + Math.max(1, timeoutMs);
            return new Promise<boolean>((resolve) => {
                const check = () => {
                    if (stopped || audioContext.state === "closed") {
                        resolve(false);
                        return;
                    }
                    if (processGeneration > startGen) {
                        resolve(true);
                        return;
                    }
                    if (performance.now() >= deadline) {
                        resolve(false);
                        return;
                    }
                    window.setTimeout(check, 32);
                };
                check();
            });
        },
        markUplink(lookbackMsArg: number) {
            if (!recordUplink) {
                return null;
            }
            const lookbackSamples = Math.ceil(
                (sampleRate * Math.max(0, lookbackMsArg)) / 1000,
            );
            return ring.mark(lookbackSamples);
        },
        copyUplinkSince(mark: UplinkRingMark) {
            if (!recordUplink) {
                return new Float32Array(0);
            }
            return ring.copyFromMark(mark);
        },
        copyUplinkRecent(ms: number) {
            if (!recordUplink) {
                return new Float32Array(0);
            }
            const n = Math.ceil((sampleRate * Math.max(0, ms)) / 1000);
            return ring.copyRecent(n);
        },
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(pollTimer);
            stopFlushSource();
            processor.onaudioprocess = null;
            try {
                source.disconnect();
                processor.disconnect();
                liveGain.disconnect();
                analyser.disconnect();
            } catch {
                // already disconnected
            }
            void audioContext.close().catch(() => undefined);
        },
    };
}
