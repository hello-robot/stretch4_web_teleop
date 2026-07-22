/**
 * Abstract base class for voice move executors.
 *
 * Consolidates shared logic between executeBaseMove.ts and executeJointMove.ts:
 *  - Single shared execution context (mode, speed-change callback, press-and-hold).
 *  - UI preparation before each voice move.
 *  - Speed and duration_ms argument coercion.
 *  - Standardised busy / disconnected result.
 */
import { FunctionProvider } from "../function_providers/FunctionProvider";
import {
    VOICE_SPEED_DEFAULT,
    VOICE_SPEEDS,
    clampDurationMs,
    VOICE_DURATION_MS_DEFAULT,
    type VoiceSpeed,
    type VoiceMoveExecutionMode,
    type ExecuteToolResult,
} from "./constants";
import type { VoiceMoveFeedback } from "./voiceMoveFeedback";

// ── Shared context type ───────────────────────────────────────────────────────

/**
 * Callbacks set by the operator UI for voice-controlled moves.
 * There is ONE shared context for all voice tool executors.
 */
export type VoiceMoveExecutionContext = {
    mode: VoiceMoveExecutionMode;
    onSpeedChange: (speed: VoiceSpeed) => void;
    onPressAndHoldRequired: () => void;
    onVoiceMoveFeedback?: (feedback: VoiceMoveFeedback) => void;
};

// ── Abstract base class ───────────────────────────────────────────────────────

export abstract class VoiceMoveExecutor {
    /** Single shared context — covers all voice tool executors. */
    private static _context: VoiceMoveExecutionContext | undefined;

    /**
     * Speed validation set, derived from VOICE_SPEEDS.
     * Available to all subclasses via `SubClass.VALID_SPEEDS`.
     */
    protected static readonly VALID_SPEEDS = new Set<string>(VOICE_SPEEDS);

    // ── Context management ────────────────────────────────────────────────────

    /** Set (or clear) the shared execution context. */
    static setContext(ctx: VoiceMoveExecutionContext | undefined): void {
        VoiceMoveExecutor._context = ctx;
    }

    /** Current execution mode, defaulting to "button_provider". */
    protected static get executionMode(): VoiceMoveExecutionMode {
        return VoiceMoveExecutor._context?.mode ?? "button_provider";
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    /**
     * Trigger UI speed sync and press-and-hold gate before a voice move.
     * Called by every concrete executor immediately before dispatching motion.
     */
    protected static prepareUi(speed: VoiceSpeed): void {
        VoiceMoveExecutor._context?.onPressAndHoldRequired();
        VoiceMoveExecutor._context?.onSpeedChange(speed);
    }

    /** Emit structured feedback for operator toasts (also used by stop/macro free helpers). */
    public static emitVoiceMoveFeedback(feedback: VoiceMoveFeedback): void {
        VoiceMoveExecutor._context?.onVoiceMoveFeedback?.(feedback);
    }
    /**
     * Coerce and validate the raw `speed` arg from Realtime tool arguments.
     * Falls back to VOICE_SPEED_DEFAULT when missing or unrecognised.
     */
    protected static parseSpeed(raw: Record<string, unknown>): VoiceSpeed {
        let speedRaw = (raw.speed as string | undefined) ?? VOICE_SPEED_DEFAULT;
        if (!VoiceMoveExecutor.VALID_SPEEDS.has(speedRaw)) {
            speedRaw = VOICE_SPEED_DEFAULT;
        }
        return speedRaw as VoiceSpeed;
    }

    /**
     * Parse and clamp the raw `duration_ms` arg from Realtime tool arguments.
     * Handles both number and string representations from the model.
     */
    protected static parseDurationMs(raw: Record<string, unknown>): number {
        let duration_ms =
            typeof raw.duration_ms === "number"
                ? raw.duration_ms
                : VOICE_DURATION_MS_DEFAULT;
        if (typeof raw.duration_ms === "string") {
            const n = Number.parseInt(raw.duration_ms, 10);
            if (!Number.isNaN(n)) duration_ms = n;
        }
        return clampDurationMs(duration_ms);
    }

    /**
     * Return a standardised failure result when the robot is busy or disconnected.
     * `path` is the method name that would have been called (for diagnostics).
     */
    protected static busyOrDisconnected(path: string): ExecuteToolResult {
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
}
