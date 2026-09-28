/**
 * Bridge so Unmute can start mic reacquire inside the same tap gesture.
 *
 * VoiceCommandAssistant registers the live session's `recoverMic`.
 * FooterGlobal calls `recoverVoiceMicFromUserGesture` on Unmute — iOS won't
 * give a working getUserMedia stream if we only recover from a store listener
 * after the click stack has unwound.
 */

export type VoiceMicRecoverFn = (opts?: {
    fromUserGesture?: boolean;
}) => Promise<void>;

let recoverFn: VoiceMicRecoverFn | null = null;

export function registerVoiceMicRecover(fn: VoiceMicRecoverFn | null): void {
    recoverFn = fn;
}

/** Kick off reacquire while still on the Unmute click stack. */
export function recoverVoiceMicFromUserGesture(): Promise<void> {
    return recoverFn?.({ fromUserGesture: true }) ?? Promise.resolve();
}
