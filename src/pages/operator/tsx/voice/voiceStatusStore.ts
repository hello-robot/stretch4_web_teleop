/**
 * External store for voice chrome UI status (footer label / mic glow).
 * Written by the headless voice session controller; read by
 * VoicePilotSceneChrome via useVoiceStatus.
 * Kept out of MobileOperator React state so mic-gate updates do not
 * re-render PilotMode / TabGroup.
 */

import { useSyncExternalStore } from "react";
import type { VoiceListeningState } from "./realtimeSession";

export type VoiceStatusSnapshot = {
    /** Realtime session is up. */
    connected: boolean;
    /** RMS threshold gate open (footer waveform / glow); not uplink bypass. */
    micGateOpen: boolean;
    /** asleep | waking | awake — drives footer copy and mic glow. */
    listeningState: VoiceListeningState;
};

const DEFAULT_STATUS: VoiceStatusSnapshot = {
    connected: false,
    micGateOpen: false,
    listeningState: "asleep",
};

/** Current status; mutated only via setVoiceStatus. */
let snapshot: VoiceStatusSnapshot = DEFAULT_STATUS;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

/** Subscribe for useSyncExternalStore; returns unsubscribe. */
export function subscribeVoiceStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Synchronous read of the current snapshot (stable identity until set). */
export function getVoiceStatusSnapshot(): VoiceStatusSnapshot {
    return snapshot;
}

/**
 * Merge patch into the snapshot.
 * No-ops (and skips notify) when nothing actually changes — important
 * because mic-gate can tick frequently.
 */
export function setVoiceStatus(
    patch: Partial<VoiceStatusSnapshot>,
): void {
    const next: VoiceStatusSnapshot = {
        connected: patch.connected ?? snapshot.connected,
        micGateOpen: patch.micGateOpen ?? snapshot.micGateOpen,
        listeningState: patch.listeningState ?? snapshot.listeningState,
    };
    if (
        next.connected === snapshot.connected &&
        next.micGateOpen === snapshot.micGateOpen &&
        next.listeningState === snapshot.listeningState
    ) {
        return;
    }
    snapshot = next;
    emit();
}

/** Subscribe a component to voice chrome status without lifting state. */
export function useVoiceStatus(): VoiceStatusSnapshot {
    return useSyncExternalStore(
        subscribeVoiceStatus,
        getVoiceStatusSnapshot,
        getVoiceStatusSnapshot, // SSR / getServerSnapshot — same client default
    );
}
