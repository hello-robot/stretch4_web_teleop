import type { BaseMoveAction, JointMoveAction, MacroMoveAction, VoiceSpeed } from "./constants";

export type VoiceMoveFeedback =
    | {
        kind: "move_started";
        action: BaseMoveAction | JointMoveAction;
        speed: VoiceSpeed;
        duration_ms: number;
        /** Pre-formatted user-facing distance string (e.g. "5°", "0.3 m", "1.2 rad").
         *  When present the toast shows this instead of the computed duration. */
        distance_display?: string;
        repeated?: boolean;
    }
    | { kind: "stop"; hadMotion: boolean }
    | {
        kind: "rejected";
        reason: "busy" | "disconnected" | "duplicate" | "invalid" | "no_repeat";
    };

const ACTION_LABELS: Record<BaseMoveAction | JointMoveAction | MacroMoveAction, string> = {
    // BASE ACTIONS
    forward: "Moving forward",
    backward: "Moving backward",
    strafe_left: "Strafing left",
    strafe_right: "Strafing right",
    rotate_left: "Turning left",
    rotate_right: "Turning right",
    // JOINT ACTIONS
    arm_lift: "Lifting arm",
    arm_lower: "Lowering arm",
    arm_extend: "Extending arm",
    arm_retract: "Retracting arm",
    wrist_roll_left: "Rolling wrist left",
    wrist_roll_right: "Rolling wrist right",
    wrist_pitch_up: "Pitching wrist up",
    wrist_pitch_down: "Pitching wrist down",
    wrist_yaw_in: "Turning wrist in",
    wrist_yaw_out: "Turning wrist out",
    gripper_open: "Opening gripper",
    gripper_close: "Closing gripper",
    // MACRO ACTIONS
    center_wrist: "Centering wrist",
    stow_wrist: "Stowing wrist",
};

const SPEED_LABELS: Record<VoiceSpeed, string> = {
    slow: "slowly",
    medium: "at medium speed",
    fast: "quickly",
};

/** Human-readable duration for toast copy. */
function formatDurationMs(ms: number): string {
    if (ms >= 1000) {
        const sec = ms / 1000;
        return sec % 1 === 0 ? `${sec} seconds` : `${sec.toFixed(1)} seconds`;
    }
    return `${ms} ms`;
}

export type VoiceMoveToast = {
    type: "success" | "error" | "info";
    message: string;
};

/** Map structured voice feedback to operator toast content. */
export function voiceMoveFeedbackToToast(
    feedback: VoiceMoveFeedback,
): VoiceMoveToast | null {
    switch (feedback.kind) {
        case "move_started": {
            const prefix = feedback.repeated ? "Repeating: " : "";
            const action = ACTION_LABELS[feedback.action];
            const speed = SPEED_LABELS[feedback.speed];
            const distPart = feedback.distance_display
                ? feedback.distance_display
                : `for ${formatDurationMs(feedback.duration_ms)}`;
            return {
                type: "info",
                message: `${prefix}${action}, ${speed}, ${distPart}`,
            };
        }
        case "stop":
            if (!feedback.hadMotion) {
                return null;
            }
            return { type: "info", message: "Stopping motion" };
        case "rejected":
            switch (feedback.reason) {
                case "busy":
                    return {
                        type: "info",
                        message: "Stretch is currently moving",
                    };
                case "disconnected":
                    return {
                        type: "error",
                        message: "Stretch Voice Control disconnected",
                    };
                case "duplicate":
                    return {
                        type: "info",
                        message: "Sounds like there's an echo",
                    };
                case "no_repeat":
                    return { type: "info", message: "There isn't a movement to repeat" };
                case "invalid":
                    return null;
            }
    }
}