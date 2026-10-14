/**
 * Operator-side voice session state.
 *
 * Local signaling: join_as_operator returns a socket.io voice session token
 * used to mint OpenAI credentials from the robot's server directly.
 * Firebase signaling: the robot answers getVoiceCapability over the WebRTC
 * data channel and relays minted credentials on requestVoiceToken.
 */

import type { Socket } from "socket.io-client";

let operatorVoiceSessionToken: string | undefined;
/** Whether the robot side can mint OpenAI credentials for this session. */
// @flag voice_control_interface
let operatorVoiceSvc = false;
const voiceSvcListeners = new Set<() => void>();
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
    const next = Boolean(enabled);
    if (next === operatorVoiceSvc) return;
    operatorVoiceSvc = next;
    voiceSvcListeners.forEach((listener) => listener());
}

export function getOperatorVoiceSvc(): boolean {
    return operatorVoiceSvc;
}

/**
 * Re-render hook for components that read isVoiceControlEnabled(): the robot's
 * voiceCapability reply can arrive after the operator UI first mounts.
 * Shaped for React.useSyncExternalStore.
 */
export function subscribeOperatorVoiceSvc(listener: () => void): () => void {
    voiceSvcListeners.add(listener);
    return () => {
        voiceSvcListeners.delete(listener);
    };
}

/**
 * The single gate for every voice control surface in the operator UI.
 *
 * Requires that server.js had the voice_control_interface flag on at startup
 * (reported in the join_as_operator reply) and that this is not a firebase
 * build (firebase operators never join the local server, so never get a voice
 * session token).
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
