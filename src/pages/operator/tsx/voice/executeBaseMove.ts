import { JOINT_VELOCITIES } from "shared/util";
import {
    ButtonPadButton,
    type ButtonFunctionProvider,
} from "../function_providers/ButtonFunctionProvider";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import {
    BASE_MOVE_ACTIONS,
    BASE_MOVE_SPEED_DEFAULT,
    BASE_MOVE_SPEEDS,
    clampDistanceM,
    clampDurationMs,
    clampRotationDeg,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_MOVE_DEDUPE_MS,
    type BaseMoveAction,
    type BaseMoveSpeed,
    type BaseRotateAction,
    type BaseTranslateAction,
    type ExecuteBaseMoveArgs,
    type ExecuteToolResult,
    type VoiceMoveExecutionMode,
} from "./constants";

const VALID_EXECUTE_ACTIONS = new Set<string>(BASE_MOVE_ACTIONS);
const VALID_SPEEDS = new Set<string>(BASE_MOVE_SPEEDS);

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

/** Last successful voice `execute_base_move` (coerced args); used by `repeat_base_move`. */
let lastVoiceBaseMove: ExecuteBaseMoveArgs | null = null;

/** Last executed move args + time (echo / double-tool-call dedupe). */
let lastExecutedMove: {
    action: BaseMoveAction;
    speed: BaseMoveSpeed;
    duration_ms: number;
    distance_m: number | undefined;
    at: number;
} | null = null;

export type VoiceMoveExecutionContext = {
    mode: VoiceMoveExecutionMode;
    onSpeedChange: (speed: BaseMoveSpeed) => void;
    onPressAndHoldRequired: () => void;
};

let voiceMoveExecutionContext: VoiceMoveExecutionContext | undefined;

export function setVoiceMoveExecutionContext(
    ctx: VoiceMoveExecutionContext | undefined,
): void {
    voiceMoveExecutionContext = ctx;
}

/** Clear repeat memory when disconnecting voice (optional UX). */
export function clearLastVoiceBaseMove(): void {
    lastVoiceBaseMove = null;
    lastExecutedMove = null;
}

function isDuplicateVoiceMove(
    action: BaseMoveAction,
    speed: BaseMoveSpeed,
    duration_ms: number,
    distance_m: number | undefined,
): boolean {
    if (lastExecutedMove === null) {
        return false;
    }
    const elapsed = Date.now() - lastExecutedMove.at;
    if (elapsed > VOICE_MOVE_DEDUPE_MS) {
        return false;
    }
    return (
        lastExecutedMove.action === action &&
        lastExecutedMove.speed === speed &&
        lastExecutedMove.duration_ms === duration_ms &&
        lastExecutedMove.distance_m === distance_m
    );
}

const BASE_LIN = JOINT_VELOCITIES.translate_mobile_base ?? 0.1;
const BASE_ANG = JOINT_VELOCITIES.rotate_mobile_base ?? 0.1;

/** Uses current `FunctionProvider.velocityScale` (UI speed preset, set before move). */
function velocitiesForAction(action: BaseMoveAction): {
    linX: number;
    linY: number;
    angVel: number;
} {
    const scale = FunctionProvider.velocityScale;
    const linVel = BASE_LIN * scale;
    const angVelMag = BASE_ANG * scale;
    switch (action) {
        case "rotate_left":
            return {
                linX: 0,
                linY: 0,
                angVel: ROTATE_ACTION_SIGN.rotate_left * angVelMag,
            };
        case "rotate_right":
            return {
                linX: 0,
                linY: 0,
                angVel: ROTATE_ACTION_SIGN.rotate_right * angVelMag,
            };
        default: {
            const [ux, uy] = BASE_MOVE_UNIT_XY[action];
            return { linX: ux * linVel, linY: uy * linVel, angVel: 0 };
        }
    }
}

function prepareVoiceMoveUi(speed: BaseMoveSpeed): void {
    voiceMoveExecutionContext?.onPressAndHoldRequired();
    voiceMoveExecutionContext?.onSpeedChange(speed);
}

function formatMoveOkDetail(
    action: BaseMoveAction,
    speed: BaseMoveSpeed,
    duration_ms: number,
    distance_m: number | undefined,
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
    const distanceStr = distance_m !== undefined
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

function busyOrDisconnectedResult(
    provider: ButtonFunctionProvider,
    path: string,
): ExecuteToolResult {
    if (!FunctionProvider.robotIsConnected()) {
        return {
            ok: false,
            detail: `No robot connection active (${path} unavailable).`,
            ignored: false,
        };
    }
    return {
        ok: false,
        detail: "Another timed voice move was already executing (busy).",
        busy: true,
    };
}

/** Parse tool arguments from partially structured model payload */
export function coerceExecuteArgs(raw: Record<string, unknown>): {
    action: BaseMoveAction;
    speed: BaseMoveSpeed;
    duration_ms: number;
    distance_m: number | undefined;
} | null {
    const action = raw.action as string | undefined;
    if (!action || !VALID_EXECUTE_ACTIONS.has(action)) {
        return null;
    }

    let speedRaw = (raw.speed as string | undefined) ?? BASE_MOVE_SPEED_DEFAULT;
    if (!VALID_SPEEDS.has(speedRaw)) {
        speedRaw = BASE_MOVE_SPEED_DEFAULT;
    }
    const speed = speedRaw as BaseMoveSpeed;

    const isRotation = action === "rotate_left" || action === "rotate_right";

    // Parse distance_m first — if present it takes priority over duration_ms.
    let distance_m: number | undefined;
    if (raw.distance_m !== undefined && raw.distance_m !== null) {
        const rawDist =
            typeof raw.distance_m === "number"
                ? raw.distance_m
                : typeof raw.distance_m === "string"
                    ? Number.parseFloat(raw.distance_m)
                    : NaN;
        if (!Number.isNaN(rawDist) && rawDist > 0) {
            distance_m = isRotation ? clampRotationDeg(rawDist) : clampDistanceM(rawDist);
        }
    }

    let duration_ms =
        typeof raw.duration_ms === "number"
            ? raw.duration_ms
            : VOICE_DURATION_MS_DEFAULT;
    if (typeof raw.duration_ms === "string") {
        const n = Number.parseInt(raw.duration_ms, 10);
        if (!Number.isNaN(n)) {
            duration_ms = n;
        }
    }

    duration_ms = clampDurationMs(duration_ms);

    return { action: action as BaseMoveAction, speed, duration_ms, distance_m };
}

export function executeBaseMoveOnProvider(
    provider: ButtonFunctionProvider,
    raw: Record<string, unknown>,
    opts?: { skipDedupe?: boolean },
): ExecuteToolResult {
    const coerced = coerceExecuteArgs(raw);
    if (!coerced) {
        return {
            ok: false,
            detail: `Invalid execute_base_move args: ${JSON.stringify(raw)}`,
            ignored: true,
        };
    }

    const { action, speed, duration_ms, distance_m } = coerced;

    if (
        !opts?.skipDedupe &&
        isDuplicateVoiceMove(action, speed, duration_ms, distance_m)
    ) {
        return {
            ok: false,
            detail: "Duplicate voice move suppressed (identical args within debounce window).",
            ignored: true,
        };
    }

    const mode = voiceMoveExecutionContext?.mode ?? "direct";
    prepareVoiceMoveUi(speed);

    // --- Distance-based path ---
    // Compute an estimated duration from distance / velocity, then dispatch
    // through the standard timed path. Safe, simple, no odom dependency.
    if (distance_m !== undefined) {
        const isRotation = action === "rotate_left" || action === "rotate_right";
        const { linX, linY, angVel } = velocitiesForAction(action);

        // For rotation the model sends degrees; convert to radians for time estimation.
        const targetNative = isRotation ? (distance_m * Math.PI) / 180 : distance_m;
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
                return busyOrDisconnectedResult(provider, "timedButtonPadPress");
            }
            lastVoiceBaseMove = { action, speed, duration_ms: clampedMs, distance_m };
            lastExecutedMove = { action, speed, duration_ms: clampedMs, distance_m, at: Date.now() };
            return {
                ok: true,
                detail: formatMoveOkDetail(action, speed, clampedMs, distance_m, mode, 0, 0, 0, button),
            };
        }

        const started = provider.timedBaseDrive(linX, linY, clampedMs, angVel);
        if (!started) {
            return busyOrDisconnectedResult(provider, "timedBaseDrive");
        }
        lastVoiceBaseMove = { action, speed, duration_ms: clampedMs, distance_m };
        lastExecutedMove = { action, speed, duration_ms: clampedMs, distance_m, at: Date.now() };
        return {
            ok: true,
            detail: formatMoveOkDetail(action, speed, clampedMs, distance_m, mode, linX, linY, angVel),
        };
    }

    // --- Duration-based path (original) ---
    if (mode === "button_provider") {
        const button = VOICE_ACTION_TO_BUTTON[action];
        const started = provider.timedButtonPadPress(button, duration_ms);
        if (!started) {
            return busyOrDisconnectedResult(
                provider,
                "timedButtonPadPress",
            );
        }
        lastVoiceBaseMove = { action, speed, duration_ms };
        lastExecutedMove = { action, speed, duration_ms, distance_m: undefined, at: Date.now() };
        return {
            ok: true,
            detail: formatMoveOkDetail(
                action,
                speed,
                duration_ms,
                undefined,
                mode,
                0,
                0,
                0,
                button,
            ),
        };
    }

    const { linX, linY, angVel } = velocitiesForAction(action);
    const started = provider.timedBaseDrive(linX, linY, duration_ms, angVel);
    if (!started) {
        return busyOrDisconnectedResult(provider, "timedBaseDrive");
    }

    lastVoiceBaseMove = { action, speed, duration_ms };
    lastExecutedMove = { action, speed, duration_ms, distance_m: undefined, at: Date.now() };

    return {
        ok: true,
        detail: formatMoveOkDetail(
            action,
            speed,
            duration_ms,
            undefined,
            mode,
            linX,
            linY,
            angVel,
        ),
    };
}

/** Replay last successful voice move (same action, speed, duration_ms). */
export function executeRepeatBaseMoveOnProvider(
    provider: ButtonFunctionProvider,
): ExecuteToolResult {
    if (lastVoiceBaseMove === null) {
        return {
            ok: false,
            detail: "No previous voice move to repeat.",
            ignored: true,
        };
    }
    return executeBaseMoveOnProvider(
        provider,
        { ...lastVoiceBaseMove } as Record<string, unknown>,
        { skipDedupe: true },
    );
}

/** Voice / pad: cancel ongoing velocity (timed voice move or continuous pilot drive). */
export function executeStopBaseMoveOnProvider(
    provider: ButtonFunctionProvider,
): ExecuteToolResult {
    const hadMotion =
        provider.timedVoiceMoveActive ||
        provider.activeVelocityAction !== undefined;
    provider.disableActiveButton();
    return {
        ok: true,
        detail: hadMotion
            ? "Stopped base motion."
            : "No active base motion to stop.",
    };
}
