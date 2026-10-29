/**
 * Pure predicates and factories for operator recovery after a backgrounded page.
 * WebRTCConnection and initConnectionStateCheck own the side effects.
 */

/** cameraInfo field carrying a one-shot renegotiation nonce, not a stream name. */
const RENEGOTIATE_CAMERA_INFO_KEY = "hr-renegotiate";
const DEFAULT_DOWN_TICKS_BEFORE_RECOVER = 4;

/**
 * Operator request for a fresh robot offer. The nonce is sent in cameraInfo so
 * the robot can echo it; offers that do not echo it are stale and must be dropped.
 */
function createRenegotiationRequest(
    createNonce = () => crypto.randomUUID(),
) {
    const nonce = createNonce();
    return {
        nonce,
        cameraInfo: { [RENEGOTIATE_CAMERA_INFO_KEY]: nonce },
    };
}

/** Nonce the peer echoed in cameraInfo, if this message is a renegotiation. */
function renegotiationNonce(cameraInfo) {
    return cameraInfo?.[RENEGOTIATE_CAMERA_INFO_KEY];
}

/**
 * Collapses overlapping recover() calls onto one in-flight promise so a second
 * rebuild does not start while the first is still joining.
 */
function createSingleFlight() {
    let inFlight;
    return (task) => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve()
            .then(task)
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };
}

/**
 * The robot should replace its peer when the connection is no longer new,
 * already has senders, or already has a data channel. Reusing that peer would
 * stack tracks and channels.
 */
function shouldResetRobotPeer({ connectionState, senderCount, hasChannel }) {
    return (
        connectionState !== "new" ||
        senderCount !== 0 ||
        hasChannel
    );
}

/** Skip recovery when this tab has yielded the seat or the document is hidden. */
function canAttemptOperatorRecovery({ yielded, hidden }) {
    return !yielded && !hidden;
}

/**
 * Count consecutive visible seconds the link is down. A healthy link or a
 * hidden page does not count. Crossing the threshold (default 4) resets the
 * count and asks the caller to recover.
 */
function advanceRecoveryWatchdog({
    linkUp,
    visible,
    downTicks,
    threshold = DEFAULT_DOWN_TICKS_BEFORE_RECOVER,
}) {
    if (linkUp) return { downTicks: 0, recover: false };
    if (!visible) return { downTicks, recover: false };
    const nextDownTicks = downTicks + 1;
    return nextDownTicks >= threshold
        ? { downTicks: 0, recover: true }
        : { downTicks: nextDownTicks, recover: false };
}

/**
 * Schedule the delayed foreground recover when the page returns from the
 * back-forward cache (persisted) or after a real visibilitychange hide.
 */
function shouldScheduleForegroundRecovery({ persisted, sawHidden }) {
    return persisted || sawHidden;
}

module.exports = {
    DEFAULT_DOWN_TICKS_BEFORE_RECOVER,
    RENEGOTIATE_CAMERA_INFO_KEY,
    advanceRecoveryWatchdog,
    canAttemptOperatorRecovery,
    createRenegotiationRequest,
    createSingleFlight,
    renegotiationNonce,
    shouldResetRobotPeer,
    shouldScheduleForegroundRecovery,
};
