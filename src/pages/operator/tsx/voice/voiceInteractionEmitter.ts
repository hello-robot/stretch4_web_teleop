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
};

export type MicEventPayload = {
    event: string;
    details?: Record<string, unknown>;
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
export function emitVoiceAssistantLog(log: string): void {
    if (!getOperatorLogSvc()) {
        return;
    }
    try {
        const socket = getInteractionSocket();
        if (!socket) {
            return;
        }
        socket.emit("voice_assistant_log", { log });
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit voice assistant log", e);
    }
}

/**
 * Shorthand aliases for emitVoiceInteraction and emitMicEvent.
 */
export const emitVoice = emitVoiceInteraction;
export const emitMic = emitMicEvent;
