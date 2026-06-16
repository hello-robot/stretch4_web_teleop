/**
 * Client-side access to the voice control assistant constants and helpers.
 * Wires in the tool names, duration bounds, and action enums for both
 * execute_base_move and execute_joint_move.
 */
import {
    BASE_MOVE_ACTIONS,
    VOICE_SPEED_DEFAULT,
    VOICE_SPEEDS,
    BASE_ROTATE_ACTIONS,
    BASE_TRANSLATE_ACTIONS,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    REPEAT_BASE_MOVE,
    VOICE_TOOLS,
    STOP_MOTION,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_MIN,
    VOICE_DISTANCE_M_MIN,
    VOICE_DISTANCE_M_MAX,
    VOICE_ROTATION_DEG_MIN,
    VOICE_ROTATION_DEG_MAX,
    JOINT_MOVE_ACTIONS,
    JOINT_LIFT_ARM_ACTIONS,
    JOINT_WRIST_ACTIONS,
    JOINT_GRIPPER_ACTIONS,
    JOINT_DISTANCE_M_MIN,
    JOINT_DISTANCE_M_MAX,
    JOINT_DISTANCE_RAD_MIN,
    JOINT_DISTANCE_RAD_MAX,
} from "ai-gateway/constants";

/**
 * Re-export constants from ai-gateway/constants.js
 * for usage in other parts of the teleop webapp.
 */
export {
    BASE_MOVE_ACTIONS,
    VOICE_SPEED_DEFAULT,
    VOICE_SPEEDS,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    REPEAT_BASE_MOVE,
    VOICE_TOOLS,
    STOP_MOTION,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_MIN,
    VOICE_DISTANCE_M_MIN,
    VOICE_DISTANCE_M_MAX,
    VOICE_ROTATION_DEG_MIN,
    VOICE_ROTATION_DEG_MAX,
    JOINT_MOVE_ACTIONS,
    JOINT_LIFT_ARM_ACTIONS,
    JOINT_WRIST_ACTIONS,
    JOINT_GRIPPER_ACTIONS,
    JOINT_DISTANCE_M_MIN,
    JOINT_DISTANCE_M_MAX,
    JOINT_DISTANCE_RAD_MIN,
    JOINT_DISTANCE_RAD_MAX,
};

// ── Base move types ───────────────────────────────────────────────────────────

/** Derived from ai-gateway action/speed enums (operator client). */
export type BaseTranslateAction = (typeof BASE_TRANSLATE_ACTIONS)[number];
export type BaseRotateAction = (typeof BASE_ROTATE_ACTIONS)[number];
export type BaseMoveAction = BaseTranslateAction | BaseRotateAction;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];

/** How voice `execute_base_move` drives the robot (temporary POC toggle). */
export type VoiceMoveExecutionMode = "direct" | "button_provider";

/** Parsed execute_base_move tool args (operator client). */
export type ExecuteBaseMoveArgs = {
    action: BaseMoveAction;
    speed?: VoiceSpeed;
    duration_ms?: number;
    /**
     * Distance-based move target.
     * - Translation actions (forward/backward/strafe): meters.
     * - Rotation actions (rotate_left/rotate_right): degrees (converted to radians client-side).
     * When set, the robot moves until odom confirms the target is reached instead of relying
     * on a fixed time duration. Falls back to an estimated duration if odom is unavailable.
     */
    distance_m?: number;
};

// ── Joint move types ──────────────────────────────────────────────────────────

/** All valid execute_joint_move.action values. */
export type JointMoveAction = (typeof JOINT_MOVE_ACTIONS)[number];

/** Parsed execute_joint_move tool args (operator client). */
export type ExecuteJointMoveArgs = {
    action: JointMoveAction;
    speed?: VoiceSpeed;
    duration_ms?: number;
    /**
     * Distance-based move target.
     * - Lift/arm actions: meters.
     * - Wrist actions: radians.
     * - Gripper actions: omit (duration only).
     */
    distance?: number;
};

/** Tool result sent back on the Realtime data channel (operator client). */
export type ExecuteToolResult =
    | { ok: true; detail: string }
    | {
        ok: false;
        detail: string;
        busy?: boolean;
        ignored?: boolean;
    };

// ── Dedupe / timing constants ─────────────────────────────────────────────────

/**
 * Suppress duplicate execute_base_move with identical args within this window (echo safety net).
 * Example: assistant echo triggers a second "forward, medium, 800ms" within 1.5s → second move is ignored.
 * Does not block intentional "again" (uses repeat_base_move, not dedupe).
 */
export const VOICE_MOVE_DEDUPE_MS = 1500;

/**
 * Cooldown after assistant speech before re-enabling mic uplink (ms).
 * Example: after "Moving forward" plays from the speaker, wait 0.5s before the gate can open again so room echo is not sent to OpenAI.
 */
export const VOICE_MIC_UNMUTE_COOLDOWN_MS = 500;

/**
 * Minimum normalized RMS (0–1) to open mic gate toward OpenAI.
 * Example: 0.03 ≈ meter tick at 3%; normal speech near the phone must pass it, quiet chatter across the room should stay below.
 * Lower = easier to trigger; higher = fewer accidental bystander commands.
 */
export const VOICE_MIC_RMS_THRESHOLD = 0.03;

/**
 * Sustained loudness before gate opens (ms).
 * Example: a brief cough or clack under threshold for <80ms does not start a voice command; speaking "move forward" does.
 */
export const VOICE_MIC_GATE_ATTACK_MS = 80;

/**
 * Keep gate open briefly after level drops (ms).
 * Example: The mic will be hot for words with trailing syllables like "for-ward" and will transmit as expected.
 */
export const VOICE_MIC_GATE_HANG_MS = 250;

/**
 * RMS polling interval (ms).
 * Example: mic meter updates ~10 times per second.
 */
export const VOICE_MIC_GATE_POLL_MS = 100;

// ── Clamp helpers ─────────────────────────────────────────────────────────────

/**
 * Clamp raw duration_ms from tool args before robot dispatch.
 * OpenAI may omit duration_ms (VOICE_DURATION_MS_DEFAULT); callers apply defaults before clamping when needed.
 *
 * @param ms raw duration from Realtime tool arguments
 * @returns rounded value in [VOICE_DURATION_MS_MIN, VOICE_DURATION_MS_MAX]
 */
export function clampDurationMs(ms: number): number {
    return Math.round(
        Math.max(VOICE_DURATION_MS_MIN, Math.min(VOICE_DURATION_MS_MAX, ms)),
    );
}

/**
 * Clamp a distance_m value from tool args before robot dispatch.
 * - For translation: value is in meters.
 * - For rotation: value is in degrees (caller converts to radians).
 *
 * @param d raw distance from Realtime tool arguments
 * @returns clamped value in [VOICE_DISTANCE_M_MIN, VOICE_DISTANCE_M_MAX]
 */
export function clampDistanceM(d: number): number {
    return Math.max(VOICE_DISTANCE_M_MIN, Math.min(VOICE_DISTANCE_M_MAX, d));
}

/**
 * Clamp a rotation degrees value from tool args before robot dispatch.
 *
 * @param d raw rotation in degrees from Realtime tool arguments
 * @returns clamped value in [VOICE_ROTATION_DEG_MIN, VOICE_ROTATION_DEG_MAX]
 */
export function clampRotationDeg(d: number): number {
    return Math.max(VOICE_ROTATION_DEG_MIN, Math.min(VOICE_ROTATION_DEG_MAX, d));
}

/**
 * Clamp a joint distance (meters) for lift/arm moves.
 *
 * @param d raw distance from tool arguments
 * @returns clamped value in [JOINT_DISTANCE_M_MIN, JOINT_DISTANCE_M_MAX]
 */
export function clampJointDistanceM(d: number): number {
    return Math.max(JOINT_DISTANCE_M_MIN, Math.min(JOINT_DISTANCE_M_MAX, d));
}

/**
 * Clamp a joint distance (radians) for wrist moves.
 *
 * @param d raw angle from tool arguments
 * @returns clamped value in [JOINT_DISTANCE_RAD_MIN, JOINT_DISTANCE_RAD_MAX]
 */
export function clampJointDistanceRad(d: number): number {
    return Math.max(JOINT_DISTANCE_RAD_MIN, Math.min(JOINT_DISTANCE_RAD_MAX, d));
}

// ── Tool set helpers ──────────────────────────────────────────────────────────

/** Union of tool names in VOICE_TOOLS; used for typed dispatch in realtimeSession.ts. */
export type VoiceToolName = (typeof VOICE_TOOLS)[number];

/**
 * Tools that omit arguments — streamed "{}" is valid completion (realtimeSession.ts).
 * Contrast with execute_base_move / execute_joint_move, which require real JSON via isPlaceholderArgs.
 */
export const NO_ARG_VOICE_TOOLS = new Set<string>([
    STOP_MOTION,
    REPEAT_BASE_MOVE,
]);

/**
 * True when Realtime has not yet delivered parsed tool args (streaming placeholders).
 * Treats empty string, "{}", and "null" as unset. Valid alone for NO_ARG_VOICE_TOOLS;
 * execute_base_move must wait for real JSON (deltas may arrive after .done sends "{}").
 */
export function isPlaceholderArgs(s: string): boolean {
    return s.length === 0 || s === "{}" || s === "null";
}

/**
 * UI / devtools: lines worth surfacing as "Last tool/trace" in VoiceCommandAssistant.tsx.
 */
export function isVoiceToolLogLine(line: string): boolean {
    return (
        VOICE_TOOLS.some((n) => line.includes(n)) ||
        line.includes("Tool execute") ||
        line.includes("Tool result")
    );
}
