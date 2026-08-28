/** Socket.io voice session token from join_as_operator (local signaling only). */

let operatorVoiceSessionToken: string | undefined;
/** Server VOICE_SVC — experimental SVC (--svc). */
let operatorVoiceSvc = false;

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
