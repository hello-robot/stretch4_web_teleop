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
