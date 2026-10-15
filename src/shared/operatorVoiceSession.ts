/** Socket.io voice session token from join_as_operator (local signaling only). */

import type { Socket } from "socket.io-client";

let operatorVoiceSessionToken: string | undefined;
/** Whether the signaling server registered its SVC routes for this session. */
// @flag voice_control_interface
let operatorVoiceSvc = false;
/**
 * Server `voice_input_recording` feature flag — pre-gate uplink Opus (mp3)
 * audio-snippet clips. Does not gate voice JSONL logging, which always runs
 * whenever SVC is enabled.
 */
let operatorVoiceInputRecording = false;
/**
 * Operator signaling socket (join_as_operator). SVC log/clip emits must use this
 * so server can gate voice_audio_clip on oper_sock — not a second io() client.
 */
let operatorInteractionSocket: Socket | null = null;

export function setOperatorVoiceSessionToken(
    token: string | undefined,
): void {
    operatorVoiceSessionToken = token;
}

export function getOperatorVoiceSessionToken(): string | undefined {
    return operatorVoiceSessionToken;
}

export function setOperatorVoiceSvc(enabled: boolean): void {
    operatorVoiceSvc = Boolean(enabled);
}

export function getOperatorVoiceSvc(): boolean {
    return operatorVoiceSvc;
}

/**
 * The single gate for every SVC surface in the operator UI.
 *
 * Requires both: the signaling server confirmed SVC for this operator session,
 * and storage is not firebase (only the local signaling server mints voice
 * session tokens).
 *
 * Keep this gate runtime-only. server.js owns the flag because it owns the
 * capability: it registers the OpenAI routes and mints the credentials, so
 * operatorVoiceSvc is the authoritative answer for this session. ANDing a
 * build-time FEATURE_* literal in here adds a second copy of that decision
 * which can only agree or be wrong -- the bundle and the server are built and
 * started independently. When they disagree the failure is silent either way:
 * the UI goes dark with nothing logged, or it offers controls the server
 * refuses.
 */
// @flag voice_control_interface
export function isVoiceControlEnabled(): boolean {
    return operatorVoiceSvc && process.env.storage !== "firebase";
}

export function setOperatorVoiceInputRecording(enabled: boolean): void {
    operatorVoiceInputRecording = Boolean(enabled);
}

export function getOperatorVoiceInputRecording(): boolean {
    return operatorVoiceInputRecording;
}

export function setOperatorInteractionSocket(socket: Socket | null): void {
    operatorInteractionSocket = socket;
}

export function getOperatorInteractionSocket(): Socket | null {
    return operatorInteractionSocket;
}
