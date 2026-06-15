/**
 * Shared voice Realtime contract (server + client).
 * Tool wire names, duration bounds, and execute_base_move enums used in
 * openai-realtime-api.js and operator voice code.
 */

/** Matches Realtime tool minimum on duration_ms in buildRealtimeVoiceSessionPayload(). */
const VOICE_DURATION_MS_MIN = 100;

/** Matches Realtime tool maximum on duration_ms in buildRealtimeVoiceSessionPayload(). */
const VOICE_DURATION_MS_MAX = 10000;

/** Server schema default when the model omits duration_ms. */
const VOICE_DURATION_MS_DEFAULT = 800;

/**
 * Minimum distance (meters) for distance-based translation moves.
 * Rotation distance_m is in degrees; this bound is reused for both.
 */
const VOICE_DISTANCE_M_MIN = 0.05;

/** Maximum distance (meters) for distance-based translation; or degrees for rotation. */
const VOICE_DISTANCE_M_MAX = 5.0;

/** Minimum rotation (degrees) for distance-based rotation. */
const VOICE_ROTATION_DEG_MIN = 1.0;

/** Maximum rotation (degrees) for distance-based rotation. */
const VOICE_ROTATION_DEG_MAX = 360.0;

/** Timed holonomic base translation or in-place rotation (action, speed, duration_ms). */
const EXECUTE_BASE_MOVE = "execute_base_move";

/** Halt ongoing base velocity (no arguments). */
const STOP_BASE_MOVE = "stop_base_move";

/** Replay last successful voice execute_base_move from client memory (no arguments). */
const REPEAT_BASE_MOVE = "repeat_base_move";

/** All voice Realtime tools registered in the session payload and executed on the client. */
const VOICE_TOOLS = [EXECUTE_BASE_MOVE, STOP_BASE_MOVE, REPEAT_BASE_MOVE];

/** Holonomic translation actions for execute_base_move.action. */
const BASE_TRANSLATE_ACTIONS = [
    "forward",
    "backward",
    "strafe_left",
    "strafe_right",
];

/** In-place rotation actions for execute_base_move.action. */
const BASE_ROTATE_ACTIONS = ["rotate_left", "rotate_right"];

/** All valid execute_base_move.action values (translation + rotation). */
const BASE_MOVE_ACTIONS = [
    ...BASE_TRANSLATE_ACTIONS,
    ...BASE_ROTATE_ACTIONS,
];

/** Speed presets for execute_base_move.speed. */
const BASE_MOVE_SPEEDS = ["slow", "medium", "fast"];

/** Server schema default when the model omits speed. */
const BASE_MOVE_SPEED_DEFAULT = "medium";

module.exports = {
    VOICE_DURATION_MS_MIN,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_DISTANCE_M_MIN,
    VOICE_DISTANCE_M_MAX,
    VOICE_ROTATION_DEG_MIN,
    VOICE_ROTATION_DEG_MAX,
    EXECUTE_BASE_MOVE,
    STOP_BASE_MOVE,
    REPEAT_BASE_MOVE,
    VOICE_TOOLS,
    BASE_TRANSLATE_ACTIONS,
    BASE_ROTATE_ACTIONS,
    BASE_MOVE_ACTIONS,
    BASE_MOVE_SPEEDS,
    BASE_MOVE_SPEED_DEFAULT,
};