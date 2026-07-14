export declare const VOICE_DURATION_MS_MIN: 100;
export declare const VOICE_DURATION_MS_MAX: 30000;
export declare const VOICE_DURATION_MS_DEFAULT: 800;
export declare const VOICE_DISTANCE_M_MIN: number;
export declare const VOICE_DISTANCE_M_MAX: number;
export declare const VOICE_ROTATION_DEG_MIN: number;
export declare const VOICE_ROTATION_DEG_MAX: number;
export declare const JOINT_DISTANCE_M_MIN: number;
export declare const JOINT_DISTANCE_M_MAX: number;
export declare const JOINT_DISTANCE_RAD_MIN: number;
export declare const JOINT_DISTANCE_RAD_MAX: number;
export declare const EXECUTE_BASE_MOVE: "execute_base_move";
export declare const EXECUTE_JOINT_MOVE: "execute_joint_move";
export declare const STOP_MOTION: "stop_motion";
export declare const REPEAT_BASE_MOVE: "repeat_base_move";
export declare const EXECUTE_MACRO: "execute_macro";
export declare const VOICE_MACRO_NAMES: readonly ["center_wrist", "stow_wrist"];
export declare const VOICE_TOOLS: readonly [
    typeof EXECUTE_BASE_MOVE,
    typeof EXECUTE_JOINT_MOVE,
    typeof STOP_MOTION,
    typeof REPEAT_BASE_MOVE,
    typeof EXECUTE_MACRO,
];

export declare const BASE_TRANSLATE_ACTIONS: readonly [
    "forward",
    "backward",
    "strafe_left",
    "strafe_right",
];
export declare const BASE_ROTATE_ACTIONS: readonly [
    "rotate_left",
    "rotate_right",
];
export declare const BASE_MOVE_ACTIONS: readonly [
    "forward",
    "backward",
    "strafe_left",
    "strafe_right",
    "rotate_left",
    "rotate_right",
];
export declare const JOINT_LIFT_ARM_ACTIONS: readonly [
    "arm_lift",
    "arm_lower",
    "arm_extend",
    "arm_retract",
];
export declare const JOINT_WRIST_ACTIONS: readonly [
    "wrist_roll_left",
    "wrist_roll_right",
    "wrist_pitch_up",
    "wrist_pitch_down",
    "wrist_yaw_in",
    "wrist_yaw_out",
];
export declare const JOINT_GRIPPER_ACTIONS: readonly [
    "gripper_open",
    "gripper_close",
];
export declare const JOINT_MOVE_ACTIONS: readonly [
    "arm_lift",
    "arm_lower",
    "arm_extend",
    "arm_retract",
    "wrist_roll_left",
    "wrist_roll_right",
    "wrist_pitch_up",
    "wrist_pitch_down",
    "wrist_yaw_in",
    "wrist_yaw_out",
    "gripper_open",
    "gripper_close",
];
export declare const MACRO_MOVE_ACTIONS: readonly [
    "center_wrist",
    "stow_wrist",
];

export declare const VOICE_SPEEDS: readonly ["slow", "medium", "fast"];
export declare const VOICE_SPEED_DEFAULT: "medium";
export declare const VOICE_SLEEP_PHRASE: "bye bye stretch";
export declare const VOICE_WAKE_PHRASE_DISPLAY: "Hello Stretch";
export declare const VOICE_SLEEP_PHRASE_DISPLAY: "Bye bye Stretch";
export declare const VOICE_WAKE_PHRASE_ALT: "hello robot";
export declare const VOICE_SLEEP_PHRASE_ALT: "bye bye robot";
export declare const VOICE_WAKE_PHRASE_ALT_DISPLAY: "Hello Robot";
export declare const VOICE_SLEEP_PHRASE_ALT_DISPLAY: "Bye bye Robot";
