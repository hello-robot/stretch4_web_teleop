export declare const VOICE_DURATION_MS_MIN: 100;
export declare const VOICE_DURATION_MS_MAX: 10000;
export declare const VOICE_DURATION_MS_DEFAULT: 800;
export declare const VOICE_DISTANCE_M_MIN: number;
export declare const VOICE_DISTANCE_M_MAX: number;
export declare const VOICE_ROTATION_DEG_MIN: number;
export declare const VOICE_ROTATION_DEG_MAX: number;
export declare const EXECUTE_BASE_MOVE: "execute_base_move";
export declare const STOP_BASE_MOVE: "stop_base_move";
export declare const REPEAT_BASE_MOVE: "repeat_base_move";
export declare const VOICE_TOOLS: readonly [
    typeof EXECUTE_BASE_MOVE,
    typeof STOP_BASE_MOVE,
    typeof REPEAT_BASE_MOVE,
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
export declare const BASE_MOVE_SPEEDS: readonly ["slow", "medium", "fast"];
export declare const BASE_MOVE_SPEED_DEFAULT: "medium";