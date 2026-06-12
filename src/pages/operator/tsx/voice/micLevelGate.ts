/**
 * This file implements the microphone level gate
 * for the voice command assistant.
 */

import {
    VOICE_MIC_GATE_ATTACK_MS,
    VOICE_MIC_GATE_HANG_MS,
    VOICE_MIC_GATE_POLL_MS,
    VOICE_MIC_RMS_THRESHOLD,
} from "./constants";

export type MicLevelGateOptions = {
    rmsThreshold?: number;
    attackMs?: number;
    hangMs?: number;
    pollIntervalMs?: number;
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
 * RMS volume gate: meters from the live input track; uplink is gated via GainNode
 * (input track stays enabled so the analyser always sees real audio).
 * Use `setForceClosed(true)` while the assistant speaks.
 */
export async function createMicLevelGate(
    stream: MediaStream,
    opts: MicLevelGateOptions,
): Promise<MicLevelGate> {
    const rmsThreshold = opts.rmsThreshold ?? VOICE_MIC_RMS_THRESHOLD;
    const attackMs = opts.attackMs ?? VOICE_MIC_GATE_ATTACK_MS;
    const hangMs = opts.hangMs ?? VOICE_MIC_GATE_HANG_MS;
    const pollMs = opts.pollIntervalMs ?? VOICE_MIC_GATE_POLL_MS;

    const audioContext = new AudioContext();
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    source.connect(gainNode);

    const destination = audioContext.createMediaStreamDestination();
    gainNode.connect(destination);

    const transmitStream = destination.stream;

    const buffer = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    );
    let currentLevel = 0;
    let gateOpen = false;
    let forceClosed = false;
    let aboveThresholdSince: number | null = null;
    let belowThresholdSince: number | null = null;

    const applyGate = () => {
        const shouldTransmit = !forceClosed && gateOpen;
        gainNode.gain.value = shouldTransmit ? 1 : 0;
        opts.onGateChange?.(gateOpen, currentLevel);
    };

    const tick = () => {
        currentLevel = computeRms(analyser, buffer);

        if (forceClosed) {
            if (gateOpen) {
                gateOpen = false;
            }
            aboveThresholdSince = null;
            belowThresholdSince = null;
            applyGate();
            return;
        }

        const now = performance.now();
        if (currentLevel >= rmsThreshold) {
            belowThresholdSince = null;
            if (aboveThresholdSince === null) {
                aboveThresholdSince = now;
            } else if (!gateOpen && now - aboveThresholdSince >= attackMs) {
                gateOpen = true;
            }
        } else if (gateOpen) {
            aboveThresholdSince = null;
            if (belowThresholdSince === null) {
                belowThresholdSince = now;
            } else if (now - belowThresholdSince >= hangMs) {
                gateOpen = false;
                belowThresholdSince = null;
            }
        } else {
            aboveThresholdSince = null;
            belowThresholdSince = null;
        }

        applyGate();
    };

    applyGate();
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
                aboveThresholdSince = null;
                belowThresholdSince = null;
            }
            applyGate();
        },
        resumeAfterForceClose() {
            forceClosed = false;
            applyGate();
        },
        stop() {
            clearInterval(pollTimer);
            source.disconnect();
            gainNode.disconnect();
            analyser.disconnect();
            void audioContext.close().catch(() => undefined);
        },
    };
}
