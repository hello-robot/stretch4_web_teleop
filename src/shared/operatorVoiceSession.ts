/** Socket.io voice session token from join_as_operator (local signaling only). */

import type { Socket } from "socket.io-client";

let operatorVoiceSessionToken: string | undefined;
/** Server LOG_SVC — voice JSONL + pre-gate uplink Opus clips (--log-svc). */
let operatorLogSvc = false;
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

export function setOperatorLogSvc(enabled: boolean): void {
    operatorLogSvc = Boolean(enabled);
}

export function getOperatorLogSvc(): boolean {
    return operatorLogSvc;
}

export function setOperatorInteractionSocket(socket: Socket | null): void {
    operatorInteractionSocket = socket;
}

export function getOperatorInteractionSocket(): Socket | null {
    return operatorInteractionSocket;
}
