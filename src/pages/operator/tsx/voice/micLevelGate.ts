/**
 * This file implements the microphone level gate
 * for the voice command assistant.
 */

import {
    VOICE_MIC_GATE_HANG_MS,
    VOICE_MIC_GATE_LOOKBACK_MS,
    VOICE_MIC_GATE_POLL_MS,
    VOICE_MIC_RMS_THRESHOLD,
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
};

export type MicLevelGate = {
    readonly transmitStream: MediaStream;
    readonly currentLevel: number;
    readonly gateOpen: boolean;
    setForceClosed: (closed: boolean) => void;
    resumeAfterForceClose: () => void;
    stop: () => void;
};

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
 * Fixed-size buffer that stores the pre-gate audio
 *
 * Once full, new samples overwrite the oldest (FIFO wrap). `filled` tracks how
 * many valid samples are present (grows until capacity, then stays at capacity).
 */
class PreGateAudioBuffer {
    private readonly buffer: Float32Array;
    /** Next write index; advances with wrap-around. */
    private writePos = 0;
    /** Number of valid samples currently stored (0 … buffer.length). */
    private filled = 0;

    /**
     * @param sampleRate AudioContext sample rate (Hz)
     * @param lookbackMs How much recent audio to retain (ms) → capacity in samples
     */
    constructor(sampleRate: number, lookbackMs: number) {
        const capacity = Math.max(
            1,
            Math.ceil((sampleRate * lookbackMs) / 1000),
        );
        this.buffer = new Float32Array(capacity);
    }

    /** Append samples; overwrites oldest data once the ring is full. */
    push(samples: Float32Array) {
        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writePos] = samples[i] ?? 0;
            this.writePos = (this.writePos + 1) % this.buffer.length;
            this.filled = Math.min(this.filled + 1, this.buffer.length);
        }
    }

    /**
     * Return stored samples in chronological order (oldest → newest).
     * Length equals `filled` (may be shorter than capacity before the ring fills).
     */
    copyOut(): Float32Array {
        const out = new Float32Array(this.filled);
        // Oldest sample sits `filled` steps behind writePos (with wrap).
        const start =
            (this.writePos - this.filled + this.buffer.length) %
            this.buffer.length;
        for (let i = 0; i < this.filled; i++) {
            out[i] = this.buffer[(start + i) % this.buffer.length] ?? 0;
        }
        return out;
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

    const audioContext = new AudioContext();
    await audioContext.resume();

    const sampleRate = audioContext.sampleRate;
    const ring = new PreGateAudioBuffer(sampleRate, lookbackMs);

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

    processor.onaudioprocess = (event) => {
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
        opts.onGateChange?.(gateOpen || bypass, currentLevel);
    };

    const flushLookback = () => {
        if (flushing || forceClosed || (opts.bypassGate?.() ?? false)) {
            return;
        }
        const samples = ring.copyOut();
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

    return {
        transmitStream,
        get currentLevel() {
            return currentLevel;
        },
        get gateOpen() {
            return gateOpen;
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
        stop() {
            clearInterval(pollTimer);
            stopFlushSource();
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
            liveGain.disconnect();
            analyser.disconnect();
            void audioContext.close().catch(() => undefined);
        },
    };
}
