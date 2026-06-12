/** Socket.io voice session token from join_as_operator (local signaling only). */

let operatorVoiceSessionToken: string | undefined;

export function setOperatorVoiceSessionToken(
    token: string | undefined,
): void {
    operatorVoiceSessionToken = token;
}

export function getOperatorVoiceSessionToken(): string | undefined {
    return operatorVoiceSessionToken;
}