/**
 * Duration limits for timed moves — driving the base or a joint at a fixed
 * velocity for a set time, then stopping.
 *
 * Owned by the motion layer so the function providers clamp every timed move
 * regardless of who requested it. The voice tool schema in
 * ai-gateway/constants.js advertises its own duration_ms range to OpenAI; that
 * range must stay inside the bounds below or requests will be silently clamped.
 */

/** Shortest timed move worth dispatching, in ms. */
export const TIMED_MOVE_MS_MIN = 100;
/** Longest single timed move, in ms. */
export const TIMED_MOVE_MS_MAX = 30000;

/**
 * @param ms requested duration in ms
 * @returns rounded value in [TIMED_MOVE_MS_MIN, TIMED_MOVE_MS_MAX]
 */
export function clampTimedMoveMs(ms: number): number {
    return Math.round(
        Math.max(TIMED_MOVE_MS_MIN, Math.min(TIMED_MOVE_MS_MAX, ms)),
    );
}
