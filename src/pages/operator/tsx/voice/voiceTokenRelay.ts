/**
 * Request/response shim over the fire-and-forget WebRTC data channel for
 * OpenAI Realtime credentials. The operator sends requestVoiceToken; the robot
 * browser mints from its local server and replies with voiceToken. Used when
 * the operator page is served from Firebase Hosting and cannot reach the
 * robot's server itself.
 */

import type { VoiceTokenMessage } from "shared/util";

const REQUEST_TIMEOUT_MS = 10_000;

type Pending = {
    resolve: (credential: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: number;
};

let sendRequest: (() => void) | null = null;
let pending: Pending | null = null;

/** Called once the data channel is open; `send` dispatches requestVoiceToken. */
export function configureVoiceTokenRelay(send: (() => void) | null): void {
    sendRequest = send;
    if (!send) {
        settle((p) => p.reject(new Error("Robot connection closed")));
    }
}

function settle(fn: (p: Pending) => void): void {
    if (!pending) return;
    const current = pending;
    pending = null;
    window.clearTimeout(current.timer);
    fn(current);
}

/** Robot reply from handleWebRTCMessage. */
export function resolveVoiceToken(message: VoiceTokenMessage): void {
    settle((p) => {
        if (message.credential) {
            p.resolve(message.credential);
        } else {
            p.reject(new Error(message.error ?? "Robot returned no credential"));
        }
    });
}

/** Raw OpenAI client_secrets payload, as the local token endpoint would return. */
export function requestVoiceTokenViaRobot(): Promise<Record<string, unknown>> {
    if (!sendRequest) {
        return Promise.reject(new Error("Robot connection not ready"));
    }
    settle((p) => p.reject(new Error("Superseded by a newer token request")));
    return new Promise((resolve, reject) => {
        pending = {
            resolve,
            reject,
            timer: window.setTimeout(() => {
                settle((p) => p.reject(new Error("Timed out waiting for the robot to mint a voice token")));
            }, REQUEST_TIMEOUT_MS),
        };
        sendRequest!();
    });
}
