/**
 * Voice tool executor for `execute_joint_move`.
 *
 * JointMoveExecutor extends VoiceMoveExecutor and inherits:
 *   - Shared execution context (mode, speed callbacks)
 *   - prepareUi, parseSpeed, parseDurationMs, busyOrDisconnected
 *
 * This file owns:
 *   - JOINT_ACTION_MAP (action → joint name, sign, unit)
 *   - Per-executor deduplication state
 *   - Distance and duration coercion for joint moves
 *   - executeStopMotionOnProvider (stops all motion)
 */
import {
    JOINT_VELOCITIES,
    type ValidJoints,
} from "shared/util";
import type { ButtonFunctionProvider } from "../function_providers/ButtonFunctionProvider";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import {
    clampDurationMs,
    clampJointDistanceM,
    clampJointDistanceRad,
    JOINT_MOVE_ACTIONS,
    VOICE_MOVE_DEDUPE_MS,
    type VoiceSpeed,
    type ExecuteToolResult,
    type JointMoveAction,
} from "./constants";
import { VoiceMoveExecutor } from "./VoiceMoveExecutor";
import { isVoiceMacroName, VOICE_MACROS } from "./voiceMacros";

// ── Action metadata ───────────────────────────────────────────────────────────

type JointUnit = "m" | "rad" | "duration";

type JointActionMeta = {
    jointName: ValidJoints;
    sign: 1 | -1;
    /** Unit of the `distance` argument the model sends. */
    unit: JointUnit;
};

/**
 * Maps each JointMoveAction to the underlying joint, direction sign, and unit.
 *
 * Signs verified against `negativeButtonPadFunctions` in ButtonFunctionProvider.tsx:
 *   ArmLower, ArmRetract, GripperClose, WristRollLeft, WristPitchUp, WristRotateOut → negative.
 *
 * Velocity magnitudes come from `JOINT_VELOCITIES` in shared/util.tsx:
 *   lift_joint: 0.04 m/s  |  arm_joint: 0.04 m/s
 *   wrist_roll_joint: 0.1 rad/s  |  wrist_pitch_joint: 0.1 rad/s  |  wrist_yaw_joint: 0.4 rad/s
 *   stretch_gripper_joint: not in JOINT_VELOCITIES → falls back to GRIPPER_FALLBACK_VEL
 */
const JOINT_ACTION_MAP: Record<JointMoveAction, JointActionMeta> = {
    // Lift (m) — ArmLower is in negativeButtonPadFunctions
    arm_lift: { jointName: "lift_joint", sign: 1, unit: "m" },
    arm_lower: { jointName: "lift_joint", sign: -1, unit: "m" },
    // Arm extension (m) — ArmRetract is in negativeButtonPadFunctions
    arm_extend: { jointName: "arm_joint", sign: 1, unit: "m" },
    arm_retract: { jointName: "arm_joint", sign: -1, unit: "m" },
    // Wrist roll (rad) — WristRollLeft is in negativeButtonPadFunctions
    wrist_roll_left: { jointName: "wrist_roll_joint", sign: -1, unit: "rad" },
    wrist_roll_right: { jointName: "wrist_roll_joint", sign: 1, unit: "rad" },
    // Wrist pitch (rad) — WristPitchUp is in negativeButtonPadFunctions
    wrist_pitch_up: { jointName: "wrist_pitch_joint", sign: -1, unit: "rad" },
    wrist_pitch_down: { jointName: "wrist_pitch_joint", sign: 1, unit: "rad" },
    // Wrist yaw (rad) — WristRotateOut is in negativeButtonPadFunctions
    wrist_yaw_in: { jointName: "wrist_yaw_joint", sign: 1, unit: "rad" },
    wrist_yaw_out: { jointName: "wrist_yaw_joint", sign: -1, unit: "rad" },
    // Gripper (duration-only) — GripperClose is in negativeButtonPadFunctions
    gripper_open: { jointName: "stretch_gripper_joint", sign: 1, unit: "duration" },
    gripper_close: { jointName: "stretch_gripper_joint", sign: -1, unit: "duration" },
};

// ── Validation sets ───────────────────────────────────────────────────────────

const VALID_JOINT_ACTIONS = new Set<string>(JOINT_MOVE_ACTIONS);

/** stretch_gripper_joint is not in JOINT_VELOCITIES; use this fallback. */
const GRIPPER_FALLBACK_VEL = 0.1;

// ── Concrete executor class ───────────────────────────────────────────────────

class JointMoveExecutor extends VoiceMoveExecutor {
    private static lastExecutedJointMove: {
        action: JointMoveAction;
        speed: VoiceSpeed;
        duration_ms: number;
        distance: number | undefined;
        at: number;
    } | null = null;

    static isDuplicate(
        action: JointMoveAction,
        speed: VoiceSpeed,
        duration_ms: number,
        distance: number | undefined,
    ): boolean {
        const last = JointMoveExecutor.lastExecutedJointMove;
        if (!last) return false;
        if (Date.now() - last.at > VOICE_MOVE_DEDUPE_MS) return false;
        return (
            last.action === action &&
            last.speed === speed &&
            last.duration_ms === duration_ms &&
            last.distance === distance
        );
    }

    static coerce(raw: Record<string, unknown>): {
        action: JointMoveAction;
        speed: VoiceSpeed;
        duration_ms: number;
        distance: number | undefined;
    } | null {
        const action = raw.action as string | undefined;
        if (!action || !VALID_JOINT_ACTIONS.has(action)) return null;

        const speed = JointMoveExecutor.parseSpeed(raw);
        const meta = JOINT_ACTION_MAP[action as JointMoveAction];

        // Parse distance — only meaningful for m/rad units.
        let distance: number | undefined;
        if (meta.unit !== "duration") {
            const rawVal =
                meta.unit === "m"
                    ? (raw.distance_m ?? raw.distance)
                    : (raw.rotation_rad ?? raw.distance);

            if (rawVal !== undefined && rawVal !== null) {
                const rawDist =
                    typeof rawVal === "number"
                        ? rawVal
                        : typeof rawVal === "string"
                            ? Number.parseFloat(rawVal)
                            : NaN;
                if (!Number.isNaN(rawDist) && rawDist > 0) {
                    distance =
                        meta.unit === "m"
                            ? clampJointDistanceM(rawDist)
                            : clampJointDistanceRad(rawDist);
                }
            }
        }

        const duration_ms = JointMoveExecutor.parseDurationMs(raw);
        return { action: action as JointMoveAction, speed, duration_ms, distance };
    }

    static velocityForAction(meta: JointActionMeta): number {
        const jointVel = JOINT_VELOCITIES[meta.jointName] ?? GRIPPER_FALLBACK_VEL;
        return meta.sign * jointVel * FunctionProvider.velocityScale;
    }

    static execute(
        provider: ButtonFunctionProvider,
        raw: Record<string, unknown>,
        opts?: { skipDedupe?: boolean; repeated?: boolean },
    ): ExecuteToolResult {
        const coerced = JointMoveExecutor.coerce(raw);
        if (!coerced) {
            JointMoveExecutor.emitVoiceMoveFeedback({ kind: "rejected", reason: "invalid" });
            return {
                ok: false,
                detail: `Invalid execute_joint_move args: ${JSON.stringify(raw)}`,
                ignored: true,
            };
        }

        const { action, speed, duration_ms, distance } = coerced;

        if (
            !opts?.skipDedupe &&
            JointMoveExecutor.isDuplicate(action, speed, duration_ms, distance)
        ) {
            JointMoveExecutor.emitVoiceMoveFeedback({ kind: "rejected", reason: "duplicate" });
            return {
                ok: false,
                detail: "Duplicate voice joint move suppressed (identical args within debounce window).",
                ignored: true,
            };
        }

        JointMoveExecutor.prepareUi(speed);

        const meta = JOINT_ACTION_MAP[action];
        const velocity = JointMoveExecutor.velocityForAction(meta);

        // ── Distance-based path ───────────────────────────────────────────────
        if (distance !== undefined && meta.unit !== "duration") {
            const absVel = Math.abs(velocity);
            const estimatedMs =
                absVel > 0
                    ? Math.round((distance / absVel) * 1000)
                    : duration_ms;
            const clampedMs = clampDurationMs(estimatedMs);

            const started = provider.incrementalJointMove(meta.jointName, meta.sign * distance);
            if (!started) {
                const result = JointMoveExecutor.busyOrDisconnected("incrementalJointMove");
                JointMoveExecutor.emitVoiceMoveFeedback({
                    kind: "rejected",
                    reason: FunctionProvider.robotIsConnected()
                        ? "busy"
                        : "disconnected",
                });
                return result;
            }
            JointMoveExecutor.lastExecutedJointMove = {
                action, speed, duration_ms: clampedMs, distance, at: Date.now(),
            };
            JointMoveExecutor.emitVoiceMoveFeedback({
                kind: "move_started",
                action,
                speed,
                duration_ms: clampedMs,
                distance_display: `${distance % 1 === 0 ? distance : distance.toFixed(2)} ${meta.unit}`,
                repeated: opts?.repeated,
            });
            return {
                ok: true,
                detail:
                    `${action} at ${speed} for ${distance.toFixed(4)} ${meta.unit}` +
                    ` (~${clampedMs}ms, incremental move via trajectory action server)`,
            };
        }

        // ── Duration-based path ───────────────────────────────────────────────
        const started = provider.timedJointMove(meta.jointName, velocity, duration_ms);
        if (!started) {
            const result = JointMoveExecutor.busyOrDisconnected("timedJointMove");
            JointMoveExecutor.emitVoiceMoveFeedback({
                kind: "rejected",
                reason: FunctionProvider.robotIsConnected()
                    ? "busy"
                    : "disconnected",
            });
            return result;
        }
        JointMoveExecutor.lastExecutedJointMove = {
            action, speed, duration_ms, distance: undefined, at: Date.now(),
        };
        JointMoveExecutor.emitVoiceMoveFeedback({
            kind: "move_started",
            action,
            speed,
            duration_ms,
            repeated: opts?.repeated,
        });
        return {
            ok: true,
            detail:
                `${action} at ${speed} for ${duration_ms}ms` +
                ` (vel=${velocity.toFixed(5)} ${meta.unit === "duration" ? "unit" : meta.unit}/s)`,
        };
    }
}

// ── Public API (backward-compatible exports) ──────────────────────────────────

/** Parse tool arguments from partially structured model payload. */
export function coerceJointMoveArgs(raw: Record<string, unknown>) {
    return JointMoveExecutor.coerce(raw);
}

/**
 * Dispatch a timed joint move.
 * - If `distance` is provided (and unit is m or rad), duration is estimated from velocity.
 * - Otherwise uses `duration_ms` directly.
 */
export function executeJointMoveOnProvider(
    provider: ButtonFunctionProvider,
    raw: Record<string, unknown>,
    opts?: { skipDedupe?: boolean; repeated?: boolean },
): ExecuteToolResult {
    return JointMoveExecutor.execute(provider, raw, opts);
}

/**
 * Stop any ongoing robot motion — base translation, rotation, arm, wrist, or gripper.
 */
export function executeStopMotionOnProvider(
    provider: ButtonFunctionProvider,
): ExecuteToolResult {
    const hadMotion =
        provider.timedVoiceMoveActive ||
        provider.activeVelocityAction !== undefined;
    provider.disableActiveButton();
    JointMoveExecutor.emitVoiceMoveFeedback({ kind: "stop", hadMotion });
    return {
        ok: true,
        detail: hadMotion
            ? "Stopped all robot motion."
            : "No active motion to stop.",
    };
}

/**
 * Execute a named voice macro — moves the robot to an absolute pose target.
 * Uses setRobotPose (relayed via RemoteRobot → FollowJointTrajectory on the robot page).
 * Only the joints defined in the macro are moved; all others stay put.
 */
export function executeMacroOnProvider(
    provider: ButtonFunctionProvider,
    raw: Record<string, unknown>,
): ExecuteToolResult {
    const macroName = typeof raw.macro === "string" ? raw.macro : "";

    if (!isVoiceMacroName(macroName)) {
        return { ok: false, detail: `Unknown macro: "${macroName}".`, ignored: true };
    }

    const pose = VOICE_MACROS[macroName];
    const started = provider.executeAbsolutePose(pose);
    if (!started) {
        JointMoveExecutor.emitVoiceMoveFeedback({
            kind: "rejected",
            reason: "disconnected",
        });
        return { ok: false, detail: "Robot not connected." };
    }
    JointMoveExecutor.emitVoiceMoveFeedback({
        kind: "macro_started",
        action: macroName,
    });
    return { ok: true, detail: `Macro "${macroName}" started.` };
}
