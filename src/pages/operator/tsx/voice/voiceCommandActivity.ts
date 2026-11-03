/**
 * Shared “valid voice command happened” activity clock.
 * Bumped on successful tools / move starts and on unmute.
 * Auto-mute polls the timestamp; auto-sleep subscribes to bumps.
 */

let lastActivityAt = 0;
const listeners = new Set<() => void>();

/** Mark activity and notify subscribers (auto-sleep idle, etc.). */
export function bumpVoiceCommandActivity(): void {
    lastActivityAt = Date.now();
    for (const listener of listeners) {
        listener();
    }
}

/** Timestamp of last bump (ms since epoch); 0 if never bumped. */
export function getLastVoiceCommandActivityAt(): number {
    return lastActivityAt;
}

/** Subscribe to bumps; returns unsubscribe. */
export function subscribeVoiceCommandActivity(
    listener: () => void,
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
