/**
 * Shared voice Realtime contract (server + client).
 * Tool wire names, duration bounds, and execute_base_move enums used in
 * openai-realtime-api.js and operator voice code.
 */

/** Matches Realtime tool minimum on duration_ms in buildRealtimeVoiceSessionPayload(). */
const VOICE_DURATION_MS_MIN = 100;

/** Matches Realtime tool maximum on duration_ms in buildRealtimeVoiceSessionPayload(). */
const VOICE_DURATION_MS_MAX = 30000;

/** Server schema default when the model omits duration_ms. */
const VOICE_DURATION_MS_DEFAULT = 800;

/**
 * Minimum distance (meters) for distance-based translation moves.
 */
const VOICE_DISTANCE_M_MIN = 0.05;

/** Maximum distance (meters) for distance-based translation moves. */
const VOICE_DISTANCE_M_MAX = 5.0;

/** Minimum rotation (degrees) for distance-based base rotation. */
const VOICE_ROTATION_DEG_MIN = 1.0;

/** Maximum rotation (degrees) for distance-based base rotation. */
const VOICE_ROTATION_DEG_MAX = 360.0;

// ── Joint move distance bounds ────────────────────────────────────────────────

/** Minimum travel (meters) for lift / arm extension joint moves. */
const JOINT_DISTANCE_M_MIN = 0.01;

/** Maximum travel (meters) for lift joint moves (full range ≈ 1.1 m). */
const JOINT_DISTANCE_M_MAX = 1.1;

/** Minimum angle (radians) for wrist joint moves. */
const JOINT_DISTANCE_RAD_MIN = 0.05;

/** Maximum angle (radians) for wrist joint moves (≈ full 2π). */
const JOINT_DISTANCE_RAD_MAX = 6.28;

// ── Tool names ────────────────────────────────────────────────────────────────

/** Timed holonomic base translation or in-place rotation (action, speed, duration_ms). */
const EXECUTE_BASE_MOVE = "execute_base_move";

/** Timed joint move for arm, wrist, and gripper (action, speed, duration_ms | distance). */
const EXECUTE_JOINT_MOVE = "execute_joint_move";

/** Halt any ongoing motion — base or joint. */
const STOP_MOTION = "stop_motion";

/** Replay last successful voice execute_base_move from client memory (no arguments). */
const REPEAT_BASE_MOVE = "repeat_base_move";

/** All voice Realtime tools registered in the session payload and executed on the client. */
const VOICE_TOOLS = [EXECUTE_BASE_MOVE, EXECUTE_JOINT_MOVE, STOP_MOTION, REPEAT_BASE_MOVE];

// ── Base move action enums ────────────────────────────────────────────────────

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

// ── Joint move action enums ───────────────────────────────────────────────────

/**
 * Lift and arm actions — distance in meters.
 * Velocity from JOINT_VELOCITIES: lift_joint = 0.04 m/s, arm_joint = 0.04 m/s.
 */
const JOINT_LIFT_ARM_ACTIONS = [
    "arm_lift",
    "arm_lower",
    "arm_extend",
    "arm_retract",
];

/**
 * Wrist rotation actions — distance in radians.
 * Velocity from JOINT_VELOCITIES: wrist_roll/pitch = 0.1 rad/s, wrist_yaw = 0.4 rad/s.
 */
const JOINT_WRIST_ACTIONS = [
    "wrist_roll_left",
    "wrist_roll_right",
    "wrist_pitch_up",
    "wrist_pitch_down",
    "wrist_yaw_in",
    "wrist_yaw_out",
];

/**
 * Gripper actions — duration-only (no meaningful distance unit).
 */
const JOINT_GRIPPER_ACTIONS = [
    "gripper_open",
    "gripper_close",
];

/** All valid execute_joint_move.action values. */
const JOINT_MOVE_ACTIONS = [
    ...JOINT_LIFT_ARM_ACTIONS,
    ...JOINT_WRIST_ACTIONS,
    ...JOINT_GRIPPER_ACTIONS,
];

// ── Speed presets (shared by both tools) ─────────────────────────────────────

/** Speed presets for execute_base_move / execute_joint_move. */
const VOICE_SPEEDS = ["slow", "medium", "fast"];

/** Server schema default when the model omits speed. */
const VOICE_SPEED_DEFAULT = "medium";

module.exports = {
    VOICE_DURATION_MS_MIN,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_DISTANCE_M_MIN,
    VOICE_DISTANCE_M_MAX,
    VOICE_ROTATION_DEG_MIN,
    VOICE_ROTATION_DEG_MAX,
    JOINT_DISTANCE_M_MIN,
    JOINT_DISTANCE_M_MAX,
    JOINT_DISTANCE_RAD_MIN,
    JOINT_DISTANCE_RAD_MAX,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    STOP_MOTION,
    REPEAT_BASE_MOVE,
    VOICE_TOOLS,
    BASE_TRANSLATE_ACTIONS,
    BASE_ROTATE_ACTIONS,
    BASE_MOVE_ACTIONS,
    JOINT_LIFT_ARM_ACTIONS,
    JOINT_WRIST_ACTIONS,
    JOINT_GRIPPER_ACTIONS,
    JOINT_MOVE_ACTIONS,
    VOICE_SPEEDS,
    VOICE_SPEED_DEFAULT,
};
