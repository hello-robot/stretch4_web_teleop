import io, { Socket } from "socket.io-client";

let socketInstance: Socket | null = null;

function getInteractionSocket(): Socket {
    if (!socketInstance) {
        socketInstance = io();
    }
    return socketInstance;
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
 */
export function emitVoiceInteraction(payload: VoiceInteractionPayload): void {
    try {
        const socket = getInteractionSocket();
        socket.emit("voice_interaction", payload);
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit voice interaction", e);
    }
}

/**
 * Emits a microphone lifecycle/health event record to the server logger.
 */
export function emitMicEvent(payload: MicEventPayload): void {
    try {
        const socket = getInteractionSocket();
        socket.emit("mic_event", payload);
    } catch (e) {
        console.warn("[voiceInteractionEmitter] Failed to emit mic event", e);
    }
}

/**
 * Emits a general VoiceCommandAssistant console log to the server logger.
 */
export function emitVoiceAssistantLog(log: string): void {
    try {
        const socket = getInteractionSocket();
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




