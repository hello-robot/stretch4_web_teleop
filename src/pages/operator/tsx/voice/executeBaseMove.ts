import { JOINT_VELOCITIES } from "shared/util";
import {
    ButtonPadButton,
    type ButtonFunctionProvider,
} from "../function_providers/ButtonFunctionProvider";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import {
    BASE_MOVE_ACTIONS,
    clampDistanceM,
    clampDurationMs,
    clampRotationRad,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_MOVE_DEDUPE_MS,
    type BaseMoveAction,
    type VoiceSpeed,
    type BaseRotateAction,
    type BaseTranslateAction,
    type ExecuteBaseMoveArgs,
    type ExecuteToolResult,
    type VoiceMoveExecutionMode,
} from "./constants";
import {
    VoiceMoveExecutor,
    type VoiceMoveExecutionContext,
} from "./VoiceMoveExecutor";

// Re-export type for backward compatibility with VoiceCommandAssistant.tsx and callers.
export type { VoiceMoveExecutionContext };

// ── Base-move-specific lookup tables ─────────────────────────────────────────

const VALID_EXECUTE_ACTIONS = new Set<string>(BASE_MOVE_ACTIONS);

/** Unit direction scaled by velocity scale (+X forward in robot frame). */
const BASE_MOVE_UNIT_XY: Record<
    BaseTranslateAction,
    readonly [number, number]
> = {
    forward: [1, 0],
    backward: [-1, 0],
    strafe_left: [0, 1],
    strafe_right: [0, -1],
};

const ROTATE_ACTION_SIGN: Record<BaseRotateAction, 1 | -1> = {
    rotate_left: 1,
    rotate_right: -1,
};

const VOICE_ACTION_TO_BUTTON: Record<BaseMoveAction, ButtonPadButton> = {
    forward: ButtonPadButton.OmniForward,
    backward: ButtonPadButton.OmniBackward,
    strafe_left: ButtonPadButton.StrafeLeft,
    strafe_right: ButtonPadButton.StrafeRight,
    rotate_left: ButtonPadButton.BaseRotateLeft,
    rotate_right: ButtonPadButton.BaseRotateRight,
};

const BASE_LIN = JOINT_VELOCITIES.translate_mobile_base ?? 0.1;
const BASE_ANG = JOINT_VELOCITIES.rotate_mobile_base ?? 0.1;

// ── Concrete executor class ───────────────────────────────────────────────────

class BaseMoveExecutor extends VoiceMoveExecutor {
    /** Last successful voice base move; used by `repeat_base_move`. */
    static lastVoiceBaseMove: ExecuteBaseMoveArgs | null = null;

    private static lastExecutedMove: {
        action: BaseMoveAction;
        speed: VoiceSpeed;
        duration_ms: number;
        distance_m: number | undefined;
        rotation_rad: number | undefined;
        at: number;
    } | null = null;

    static clear(): void {
        BaseMoveExecutor.lastVoiceBaseMove = null;
        BaseMoveExecutor.lastExecutedMove = null;
    }

    static isDuplicate(
        action: BaseMoveAction,
        speed: VoiceSpeed,
        duration_ms: number,
        distance_m: number | undefined,
        rotation_rad: number | undefined,
    ): boolean {
        const last = BaseMoveExecutor.lastExecutedMove;
        if (!last) return false;
        if (Date.now() - last.at > VOICE_MOVE_DEDUPE_MS) return false;
        return (
            last.action === action &&
            last.speed === speed &&
            last.duration_ms === duration_ms &&
            last.distance_m === distance_m &&
            last.rotation_rad === rotation_rad
        );
    }

    static velocitiesForAction(action: BaseMoveAction): {
        linX: number;
        linY: number;
        angVel: number;
    } {
        const scale = FunctionProvider.velocityScale;
        const linVel = BASE_LIN * scale;
        const angVelMag = BASE_ANG * scale;
        switch (action) {
            case "rotate_left":
                return { linX: 0, linY: 0, angVel: ROTATE_ACTION_SIGN.rotate_left * angVelMag };
            case "rotate_right":
                return { linX: 0, linY: 0, angVel: ROTATE_ACTION_SIGN.rotate_right * angVelMag };
            default: {
                const [ux, uy] = BASE_MOVE_UNIT_XY[action];
                return { linX: ux * linVel, linY: uy * linVel, angVel: 0 };
            }
        }
    }

    static coerce(raw: Record<string, unknown>): {
        action: BaseMoveAction;
        speed: VoiceSpeed;
        duration_ms: number;
        distance_m: number | undefined;
        rotation_rad: number | undefined;
    } | null {
        const action = raw.action as string | undefined;
        if (!action || !VALID_EXECUTE_ACTIONS.has(action)) return null;

        const speed = BaseMoveExecutor.parseSpeed(raw);
        const isRotation = action === "rotate_left" || action === "rotate_right";

        let distance_m: number | undefined;
        let rotation_rad: number | undefined;

        if (!isRotation && raw.distance_m !== undefined && raw.distance_m !== null) {
            const rawDist =
                typeof raw.distance_m === "number"
                    ? raw.distance_m
                    : typeof raw.distance_m === "string"
                        ? Number.parseFloat(raw.distance_m)
                        : NaN;
            if (!Number.isNaN(rawDist) && rawDist > 0) {
                distance_m = clampDistanceM(rawDist);
            }
        }

        if (isRotation && raw.rotation_rad !== undefined && raw.rotation_rad !== null) {
            const rawRot =
                typeof raw.rotation_rad === "number"
                    ? raw.rotation_rad
                    : typeof raw.rotation_rad === "string"
                        ? Number.parseFloat(raw.rotation_rad)
                        : NaN;
            if (!Number.isNaN(rawRot) && rawRot > 0) {
                rotation_rad = clampRotationRad(rawRot);
            }
        }

        const duration_ms = BaseMoveExecutor.parseDurationMs(raw);
        return { action: action as BaseMoveAction, speed, duration_ms, distance_m, rotation_rad };
    }

    static execute(
        provider: ButtonFunctionProvider,
        raw: Record<string, unknown>,
        opts?: { skipDedupe?: boolean; repeated?: boolean },
    ): ExecuteToolResult {
        const coerced = BaseMoveExecutor.coerce(raw);
        if (!coerced) {
            BaseMoveExecutor.emitVoiceMoveFeedback({ kind: "rejected", reason: "invalid" });
            return {
                ok: false,
                detail: `Invalid execute_base_move args: ${JSON.stringify(raw)}`,
                ignored: true,
            };
        }

        const { action, speed, duration_ms, distance_m, rotation_rad } = coerced;

        if (
            !opts?.skipDedupe &&
            BaseMoveExecutor.isDuplicate(action, speed, duration_ms, distance_m, rotation_rad)
        ) {
            BaseMoveExecutor.emitVoiceMoveFeedback({ kind: "rejected", reason: "invalid" });
            return {
                ok: false,
                detail: "Duplicate voice move suppressed (identical args within debounce window).",
                ignored: true,
            };
        }

        const mode = BaseMoveExecutor.executionMode;
        BaseMoveExecutor.prepareUi(speed);

        // ── Distance/Rotation-based path ───────────────────────────────────────────────
        if (distance_m !== undefined || rotation_rad !== undefined) {
            const isRotation = action === "rotate_left" || action === "rotate_right";
            const { linX, linY, angVel } = BaseMoveExecutor.velocitiesForAction(action);

            // For rotation we use rotation_rad (radians); for translation we use distance_m (meters).
            const targetNative = isRotation ? (rotation_rad ?? 0) : distance_m!;
            const speed_mps = isRotation
                ? Math.abs(angVel)
                : Math.max(Math.abs(linX), Math.abs(linY));
            const estimatedMs = speed_mps > 0
                ? Math.round((targetNative / speed_mps) * 1000)
                : VOICE_DURATION_MS_DEFAULT;
            const clampedMs = clampDurationMs(estimatedMs);

            if (mode === "button_provider") {
                const button = VOICE_ACTION_TO_BUTTON[action];
                const started = provider.timedButtonPadPress(button, clampedMs);
                if (!started) {
                    const result = BaseMoveExecutor.busyOrDisconnected(
                        "timedButtonPadPress",
                    );
                    BaseMoveExecutor.emitVoiceMoveFeedback({
                        kind: "rejected",
                        reason: FunctionProvider.robotIsConnected()
                            ? "busy"
                            : "disconnected",
                    });
                    return result;
                }
                BaseMoveExecutor.lastVoiceBaseMove = { action, speed, duration_ms: clampedMs, distance_m, rotation_rad };
                BaseMoveExecutor.lastExecutedMove = { action, speed, duration_ms: clampedMs, distance_m, rotation_rad, at: Date.now() };
                BaseMoveExecutor.emitVoiceMoveFeedback({
                    kind: "move_started",
                    action,
                    speed,
                    duration_ms: clampedMs,
                    distance_display: isRotation
                        ? `${rotation_rad !== undefined ? ((rotation_rad * 180) / Math.PI).toFixed(1) : 0}°`
                        : `${distance_m! % 1 === 0 ? distance_m! : distance_m!.toFixed(2)} m`,
                    repeated: opts?.repeated,
                });
                return {
                    ok: true,
                    detail: formatMoveOkDetail(action, speed, clampedMs, distance_m, rotation_rad, mode, 0, 0, 0, button),
                };
            }

            const started = provider.timedBaseDrive(linX, linY, clampedMs, angVel);
            if (!started) {
                const result = BaseMoveExecutor.busyOrDisconnected("timedBaseDrive");
                BaseMoveExecutor.emitVoiceMoveFeedback({
                    kind: "rejected",
                    reason: FunctionProvider.robotIsConnected()
                        ? "busy"
                        : "disconnected",
                });
                return result;
            }
            BaseMoveExecutor.lastVoiceBaseMove = { action, speed, duration_ms: clampedMs, distance_m, rotation_rad };
            BaseMoveExecutor.lastExecutedMove = { action, speed, duration_ms: clampedMs, distance_m, rotation_rad, at: Date.now() };
            BaseMoveExecutor.emitVoiceMoveFeedback({
                kind: "move_started",
                action,
                speed,
                duration_ms: clampedMs,
                distance_display: isRotation
                    ? `${rotation_rad !== undefined ? ((rotation_rad * 180) / Math.PI).toFixed(1) : 0}°`
                    : `${distance_m! % 1 === 0 ? distance_m! : distance_m!.toFixed(2)} m`,
                repeated: opts?.repeated,
            });
            return {
                ok: true,
                detail: formatMoveOkDetail(action, speed, clampedMs, distance_m, rotation_rad, mode, linX, linY, angVel),
            };
        }

        // ── Duration-based path ───────────────────────────────────────────────
        if (mode === "button_provider") {
            const button = VOICE_ACTION_TO_BUTTON[action];
            const started = provider.timedButtonPadPress(button, duration_ms);
            if (!started) {
                const result = BaseMoveExecutor.busyOrDisconnected("timedButtonPadPress");
                BaseMoveExecutor.emitVoiceMoveFeedback({
                    kind: "rejected",
                    reason: FunctionProvider.robotIsConnected()
                        ? "busy"
                        : "disconnected",
                });
                return result;
            }
            BaseMoveExecutor.lastVoiceBaseMove = { action, speed, duration_ms };
            BaseMoveExecutor.lastExecutedMove = { action, speed, duration_ms, distance_m: undefined, rotation_rad: undefined, at: Date.now() };
            BaseMoveExecutor.emitVoiceMoveFeedback({
                kind: "move_started",
                action,
                speed,
                duration_ms,
                repeated: opts?.repeated,
            });
            return {
                ok: true,
                detail: formatMoveOkDetail(action, speed, duration_ms, undefined, undefined, mode, 0, 0, 0, button),
            };
        }

        const { linX, linY, angVel } = BaseMoveExecutor.velocitiesForAction(action);
        const started = provider.timedBaseDrive(linX, linY, duration_ms, angVel);
        if (!started) {
            const result = BaseMoveExecutor.busyOrDisconnected("timedBaseDrive");
            BaseMoveExecutor.emitVoiceMoveFeedback({
                kind: "rejected",
                reason: FunctionProvider.robotIsConnected()
                    ? "busy"
                    : "disconnected",
                });
            return result;
        }
        BaseMoveExecutor.lastVoiceBaseMove = { action, speed, duration_ms };
        BaseMoveExecutor.lastExecutedMove = { action, speed, duration_ms, distance_m: undefined, rotation_rad: undefined, at: Date.now() };
        BaseMoveExecutor.emitVoiceMoveFeedback({
            kind: "move_started",
            action,
            speed,
            duration_ms,
            repeated: opts?.repeated,
        });
        return {
            ok: true,
            detail: formatMoveOkDetail(action, speed, duration_ms, undefined, undefined, mode, linX, linY, angVel),
        };
    }
}

// ── Base-move-specific format helper ─────────────────────────────────────────

function formatMoveOkDetail(
    action: BaseMoveAction,
    speed: VoiceSpeed,
    duration_ms: number,
    distance_m: number | undefined,
    rotation_rad: number | undefined,
    mode: VoiceMoveExecutionMode,
    linX: number,
    linY: number,
    angVel: number,
    button?: ButtonPadButton,
): string {
    const via =
        mode === "button_provider"
            ? ` via ${button ?? "button"}`
            : " via direct drive";
    const distanceStr =
        rotation_rad !== undefined
            ? ` for ${rotation_rad.toFixed(5)} rad (odom-tracked)`
            : distance_m !== undefined
                ? ` for ${distance_m.toFixed(5)} m (odom-tracked)`
                : ` for ${duration_ms}ms`;
    let detail = `${action} at ${speed}${distanceStr}${via}`;
    if (mode === "direct") {
        detail += ` (~linVelX=${linX.toFixed(5)}, linVelY=${linY.toFixed(5)}`;
        if (angVel !== 0) {
            detail += `, angVel=${angVel.toFixed(5)}`;
        }
        detail += ")";
    }
    return detail;
}

// ── Public API (backward-compatible exports) ──────────────────────────────────

/**
 * Set (or clear) the shared voice move execution context for all executors.
 * Delegates to VoiceMoveExecutor.setContext — one call covers base and joint moves.
 */
export function setVoiceMoveExecutionContext(
    ctx: VoiceMoveExecutionContext | undefined,
): void {
    VoiceMoveExecutor.setContext(ctx);
}

/** Clear repeat memory when disconnecting voice (optional UX). */
export function clearLastVoiceBaseMove(): void {
    BaseMoveExecutor.clear();
}

/** Parse tool arguments from partially structured model payload. */
export function coerceExecuteArgs(raw: Record<string, unknown>) {
    return BaseMoveExecutor.coerce(raw);
}

/** Execute a base move voice command on the given provider. */
export function executeBaseMoveOnProvider(
    provider: ButtonFunctionProvider,
    raw: Record<string, unknown>,
    opts?: { skipDedupe?: boolean; repeated?: boolean },
): ExecuteToolResult {
    return BaseMoveExecutor.execute(provider, raw, opts);
}

/** Replay the last successful voice base move (same action, speed, duration_ms). */
export function executeRepeatBaseMoveOnProvider(
    provider: ButtonFunctionProvider,
): ExecuteToolResult {
    if (BaseMoveExecutor.lastVoiceBaseMove === null) {
        return {
            ok: false,
            detail: "No previous voice move to repeat.",
            ignored: true,
        };
    }
    return BaseMoveExecutor.execute(
        provider,
        { ...BaseMoveExecutor.lastVoiceBaseMove } as Record<string, unknown>,
        { skipDedupe: true },
    );
}
