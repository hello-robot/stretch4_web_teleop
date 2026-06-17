/**
 * Voice macro definitions for `execute_macro`.
 *
 * Each macro is a partial RobotPose — a map from ValidJoints to absolute
 * position values (radians for rotary joints, meters for linear joints).
 * Macros are executed via `FunctionProvider.remoteRobot.executePoseGoal()`,
 * which uses the FollowJointTrajectory action server (navigation mode).
 *
 * To add a new macro:
 *   1. Add the name to `VOICE_MACRO_NAMES` in `ai-gateway/constants.js`.
 *   2. Add the corresponding entry here.
 *   3. Add the name and description to the system instructions in
 *      `openai-realtime-api.js`.
 */
import type { RobotPose } from "shared/util";

export type VoiceMacroName = "center_wrist" | "stow_wrist";

/**
 * Maps macro name → target RobotPose.
 * Only the joints listed will be moved; all others are left at their current positions.
 */
export const VOICE_MACROS: Record<VoiceMacroName, RobotPose> = {
    /**
     * Center all wrist DOFs: roll=0, pitch=0, yaw=0.
     * Useful for resetting the wrist to a neutral forward-facing position.
     */
    center_wrist: {
        wrist_roll_joint: 0,
        wrist_pitch_joint: 0,
        wrist_yaw_joint: 0,
    },

    /**
     * Stow wrist: yaw=π/2, pitch=0, roll=0.
     * Rotates the wrist 90° inward (yaw) — a compact carry/stow pose.
     */
    stow_wrist: {
        wrist_yaw_joint: Math.PI,
        wrist_pitch_joint: 0,
        wrist_roll_joint: 0,
    },
};

/**
 * Type guard — returns true when `name` is a key in VOICE_MACROS.
 */
export function isVoiceMacroName(name: string): name is VoiceMacroName {
    return Object.prototype.hasOwnProperty.call(VOICE_MACROS, name);
}
