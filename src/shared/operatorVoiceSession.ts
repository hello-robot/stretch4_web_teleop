/** Socket.io voice session token from join_as_operator (local signaling only). */

import { FEATURE_VOICE_CONTROL_INTERFACE } from "shared/featureFlags";

let operatorVoiceSessionToken: string | undefined;
/** Whether the signaling server registered its SVC routes for this session. */
// @flag voice_control_interface
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

/**
 * The single gate for every SVC surface in the operator UI.
 *
 * Requires all three: the flag was on when this bundle was built, the
 * signaling server confirmed SVC for this operator session, and storage is not
 * firebase (only the local signaling server mints voice session tokens).
 */
// @flag voice_control_interface
export function isVoiceControlEnabled(): boolean {
    return (
        FEATURE_VOICE_CONTROL_INTERFACE &&
        operatorVoiceSvc &&
        process.env.storage !== "firebase"
    );
}
