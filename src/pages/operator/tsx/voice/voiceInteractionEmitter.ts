import type { Socket } from "socket.io-client";
import {
    getOperatorInteractionSocket,
    getOperatorLogSvc,
} from "shared/operatorVoiceSession";

function getInteractionSocket(): Socket | null {
    return getOperatorInteractionSocket();
}

export type VoiceInteractionPayload = {
    transcript: string;
    stt_model?: string;
    tool_name: string;
    tool_args: Record<string, unknown>;
    reasoning_model?: string;
    success: boolean;
    detail: string;
    listening_state?: string;
    execution_mode?: string;
    /** Realtime conversation item id — joins uplink Opus clip when logging. */
    item_id?: string;
    audio_start_ms?: number;
    audio_end_ms?: number;
};

export type MicEventPayload = {
    event: string;
    details?: Record<string, unknown>;
};

export type VoiceAudioClipPayload = {
    item_id: string;
    sampleRate: number;
    /** Int16 LE PCM mono */
    pcm: ArrayBuffer;
    audio_start_ms?: number;
    audio_end_ms?: number;
};

/**
 * Emits a structured voice interaction record to the server logger.
 * No-op unless launch used --log-svc (logSvc from join_as_operator).
 */
export function emitVoiceInteraction(payload: VoiceInteractionPayload): void {
    if (!getOperatorLogSvc()) {
        return;
    }
    try {
        const socket = getInteractionSocket();
        if (!socket) {
            return;
        }
        socket.emit("voice_interaction", payload);
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit voice interaction", e);
    }
}

/**
 * Emits a microphone lifecycle/health event record to the server logger.
 * No-op unless --log-svc.
 */
export function emitMicEvent(payload: MicEventPayload): void {
    if (!getOperatorLogSvc()) {
        return;
    }
    try {
        const socket = getInteractionSocket();
        if (!socket) {
            return;
        }
        socket.emit("mic_event", payload);
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit mic event", e);
    }
}

/**
 * Emits a general VoiceCommandAssistant console log to the server logger.
 * No-op unless --log-svc.
 */
export function emitVoiceAssistantLog(
    log: string,
    meta?: { item_id?: string; audio_start_ms?: number; audio_end_ms?: number },
): void {
    if (!getOperatorLogSvc()) {
        return;
    }
    try {
        const socket = getInteractionSocket();
        if (!socket) {
            return;
        }
        socket.emit("voice_assistant_log", {
            log,
            item_id: meta?.item_id,
            audio_start_ms: meta?.audio_start_ms,
            audio_end_ms: meta?.audio_end_ms,
        });
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit voice assistant log", e);
    }
}

/**
 * Uploads a pre-gate mic PCM clip for server-side Opus encoding.
 * No-op unless --log-svc.
 */
export function emitVoiceAudioClip(payload: VoiceAudioClipPayload): void {
    if (!getOperatorLogSvc()) {
        return;
    }
    try {
        const socket = getInteractionSocket();
        if (!socket) {
            return;
        }
        socket.emit("voice_audio_clip", {
            item_id: payload.item_id,
            sampleRate: payload.sampleRate,
            pcm: payload.pcm,
            audio_start_ms: payload.audio_start_ms,
            audio_end_ms: payload.audio_end_ms,
        });
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit voice audio clip", e);
    }
}

/**
 * Shorthand aliases for emitVoiceInteraction and emitMicEvent.
 */
export const emitVoice = emitVoiceInteraction;
export const emitMic = emitMicEvent;
