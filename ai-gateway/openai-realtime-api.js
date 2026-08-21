/**
 * This file contains the auth and harness for working with OpenAI Realtime API
 *
 * Builds the Realtime session payload (model, movement tool schemas, VAD config)
 * and registers `GET /openai-realtime/token`, which mints an ephemeral client secret
 * so the browser can open a WebRTC session without exposing `OPENAI_API_KEY`.
 *
 * Mint requires header `X-Voice-Session-Token` when `opts.validateVoiceSession` is set
 * (local socket.io operator session from `voice-session-auth.js`).
 *
 * Wired into the app by `server.js` via `registerOpenAiRealtimeRoutes(app, opts)`.
 * Shared tool names, duration bounds, and action enums live in `./constants.js`.
 */
const {
    BASE_MOVE_ACTIONS,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    JOINT_DISTANCE_M_MAX,
    JOINT_DISTANCE_M_MIN,
    JOINT_DISTANCE_RAD_MAX,
    JOINT_DISTANCE_RAD_MIN,
    JOINT_LIFT_ARM_ACTIONS,
    JOINT_MOVE_ACTIONS,
    JOINT_WRIST_ACTIONS,
    REPEAT_BASE_MOVE,
    STOP_MOTION,
    VOICE_SPEED_DEFAULT,
    VOICE_SPEEDS,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_MIN,
    VOICE_DISTANCE_M_MIN,
    VOICE_DISTANCE_M_MAX,
    VOICE_ROTATION_DEG_MIN,
    VOICE_ROTATION_DEG_MAX,
    EXECUTE_MACRO,
    SWITCH_SCENE,
    SAVE_MAP_LOCATION,
    SET_SAVED_LOCATIONS_MODAL,
    SET_MAIN_MENU,
    CONTROL_AUTONAV,
    LOAD_AUTONAV_LOCATION,
    VOICE_MACRO_NAMES,
    VOICE_SCENE_NAMES,
    SAVED_LOCATIONS_MODAL_ACTIONS,
    MAIN_MENU_ACTIONS,
    AUTONAV_NAV_ACTIONS,
    VOICE_WAKE_PHRASE_DISPLAY,
    VOICE_SLEEP_PHRASE_DISPLAY,
    VOICE_WAKE_PHRASE_ALT_DISPLAY,
    VOICE_SLEEP_PHRASE_ALT_DISPLAY,
} = require("./constants");

const VOICE_ROTATION_RAD_MIN = Number(((VOICE_ROTATION_DEG_MIN * Math.PI) / 180).toFixed(5));
const VOICE_ROTATION_RAD_MAX = Number(((VOICE_ROTATION_DEG_MAX * Math.PI) / 180).toFixed(5));

/**
 * Builds a no-argument voice tool for the OpenAI Realtime API.
 * @param name - The name of the tool.
 * @param description - The description of the tool.
 * @returns The no-argument voice tool for the OpenAI Realtime API.
 */
function noArgVoiceTool(name, description) {
    return {
        type: "function",
        name,
        description,
        parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    };
}

/**
 * The harness and payload builder for OpenAI Realtime API voice assistant.
 *
 * Builds the payload for the OpenAI Realtime API.
 * @returns The payload for the OpenAI Realtime API.
 */
function buildRealtimeVoiceSessionPayload() {
    return {
        session: {
            type: "realtime",
            model: "gpt-realtime-2.1",
            // The harness!
            instructions: [
                // Identity and tone
                `Do not respond to the user. Do not speak to the user. Only call tools as instructed.`,

                // Wake/sleep phrases — do not tool-call
                `When the user says only "${VOICE_WAKE_PHRASE_DISPLAY}", "${VOICE_WAKE_PHRASE_ALT_DISPLAY}", or similar wake greetings, do NOT call any tool.`,
                `When the user says only "${VOICE_SLEEP_PHRASE_DISPLAY}", "${VOICE_SLEEP_PHRASE_ALT_DISPLAY}", or similar farewells, do NOT call any tool.`,

                // ── Base move harness ────────────────────────────────────────────────────
                `The user speaks imprecisely. Infer AT MOST ONE robot motion per turn: base translation, base rotation, or arm motion.`,

                // ── Define basic motion ────────────────────────────────────────────────────
                `The robot is a mobile manipulation platform with a holonomic base, a lift that moves the arm up and down, a telescoping arm that moves in and out, a 3 degree of freedom wrist with roll, pitch and yaw joints, and a gripper that opens and closes.`,
                `The arm points in the robot's "forward" direction. The wrist has predefined "stow" and "center" poses. "Center" represents the wrist pointing in the forward direction`,

                `Base translation means the robot body slides without turning.`,
                `For base translations, call tool \`${EXECUTE_BASE_MOVE}\` with \`action\` (enum), \`speed\` (${VOICE_SPEEDS.join("|")}), and EITHER \`duration_ms\` OR \`distance_m\`.`,
                `Base translation may include one of the following actions: { \`forward\` | \`backward\` | \`strafe_left\` | \`strafe_right\` }.`,
                `CRITICAL DISAMBIGUATION: use \`strafe_left\` for commands such as "move left", "go left", "slide left", "strafe left", "left", "shift left", "lateral left".`,
                `CRITICAL DISAMBIGUATION: use \`strafe_right\` for commands such as "move right", "go right", "slide right", "strafe right", "right", "shift right", "lateral right".`,

                `Base rotation means the robot body turns/spins in place.`,
                `For base rotations, call tool \`${EXECUTE_BASE_MOVE}\` with \`action\` (enum), \`speed\` (${VOICE_SPEEDS.join("|")}), and EITHER \`duration_ms\` OR \`rotation_rad\`.`,
                `Base rotation may include one of the following actions: { \`rotate_left\` | \`rotate_right\` }.`,
                `Use \`rotate_left\` ONLY when the user explicitly says "turn", "rotate", "spin", "face", or "pivot" left.`,
                `Use \`rotate_right\` ONLY when the user explicitly says "turn", "rotate", "spin", "face", or "pivot" right.`,

                `Arm motions include moving the lift up or down, moving the arm in or out, moving one of the 3 wrist joints, or opening and closing the gripper`,
                `For lift/arm joint actions (${JOINT_LIFT_ARM_ACTIONS.join("|")}), distance is meters (${JOINT_DISTANCE_M_MIN}-${JOINT_DISTANCE_M_MAX}) and should be passed as \`distance_m\`.`,
                `For wrist joint actions (${JOINT_WRIST_ACTIONS.join("|")}), distance is radians (${JOINT_DISTANCE_RAD_MIN}-${JOINT_DISTANCE_RAD_MAX}) and should be passed as \`rotation_rad\`.`,
                `For \`gripper_open\` and \`gripper_close\`, omit \`distance_m\` and use \`duration_ms\`.`,
                `If neither distance nor time is specified for joint movement, set \`duration_ms\`=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says "stop"). Default \`speed\` is ${VOICE_SPEED_DEFAULT}.`,

                `CRITICAL DISAMBIGUATION for "gripper" commands: The gripper joint can ONLY open or close.`,
                `When the user asks to change the gripper's location in space, you must map their intent to the structural joints:`,
                `If they say "move gripper up" or "move gripper down", use the lift joint.`,
                `If they say "move gripper forward/back", "push gripper out", or "pull gripper in", use the arm joint.`,
                `Use \`gripper_open\` or \`gripper_close\` ONLY when the user explicitly wants to grasp, grab, drop, or release an object.`,

                `Pointing is unique and refers to the gripper's orientation relative to the base's forward direction.`,
                `If the user asks to "point forward" or "point straight", call \`${EXECUTE_MACRO}\` with \`macro="center_wrist"\`.`,
                `If they ask to "point left" or "point right", use the wrist YAW joint. Use "wrist_yaw_in" for pointing left, and "wrist_yaw_out" for pointing right.`,
                `If they ask to "point up" or "point down", use the wrist PITCH joint.`,
                `If they ask to "tilt" or "turn" the gripper, use the wrist ROLL joint.`,

                `Orientation words without a specific joint such as "aim", "look", or "face" refer to a base rotation in place.`,
                `For base rotation commands without a specified amount (e.g., "aim left", "look behind you"), default to absolute turns:`,
                `Set \`rotation_rad\`=1.57 for "left" or "right", and 3.14 for "back" or "around".`,
                `If the user adds a modifier (e.g., "aim left a little bit", "point right 45 degrees"), override these defaults and infer the appropriate \`rotation_rad\` or a short \`duration_ms\`.`,

                // ── Guard rails ────────────────────────────────────────────────────────────────────────────
                `If the user specifies a distance, set \`distance_m\` in meters and omit \`duration_ms\` and \`rotation_rad\`.`,
                `If the user specifies a rotation angle, set \`rotation_rad\` in radians and omit \`duration_ms\` and \`distance_m\`.`,
                `If the user specifies an explicit time (e.g. "move forward for 2 seconds"), set \`duration_ms\` in milliseconds and omit \`distance_m\` and \`rotation_rad\`.`,
                `If ambiguous, prefer slower/shorter movements.`,
                `Infer AT MOST ONE robot motion per turn. Never call both  \`${EXECUTE_BASE_MOVE}\` and \`${EXECUTE_JOINT_MOVE}\` in the same utterance.`,
                `If neither distance nor time is specified for base movement, set \`duration_ms\`=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says "stop").`,
                `After a tool result, never call a movement tool again unless the user gives a new command.`,

                // ── Stop / repeat ────────────────────────────────────────────────────────────────────────────
                `When the user wants to halt ANY motion ("stop", "wait", "freeze", "do not move", "cut that", "enough", "pause", "cancel"), call tool \`${STOP_MOTION}\` with no arguments — not a movement tool.`,
                `Call \`${STOP_MOTION}\` IMMEDIATELY whenever the user says any word that indicates stopping, even mid-sentence.`,
                `The client also cancels active AutoNav navigation when \`${STOP_MOTION}\` runs — bare "stop" is enough while AutoNav is navigating. Explicit "AutoNav stop" / "AutoNav cancel" / "Navigation cancel" / "Cancel navigation" may still use \`${CONTROL_AUTONAV}\` with \`action="cancel"\`.`,
                `When the user wants to repeat the last base move ("again", "same thing", "one more time", "do that again"), call tool \`${REPEAT_BASE_MOVE}\` with no arguments — not \`${EXECUTE_BASE_MOVE}\` with guessed parameters. Ensure you are over 90% confident that the user asked you to repeat previous movement before you move.`,

                // ── Macro actions ──────────────────────────────────────────────────────────────────────────
                `Macro actions move the robot to predefined poses. Call \`${EXECUTE_MACRO}\` with the appropriate \`macro\` name.`,
                `\`macro="center_wrist"\`: centers the wrist to roll=0, pitch=0, yaw=0. Phrases: "center the wrist", "reset wrist", "straighten wrist", "wrist to zero", "zero wrist", "center wrist".`,
                `\`macro="stow_wrist"\`: moves the wrist to the robot's stow pose. Phrases: "stow the wrist", "stow wrist", "tuck wrist", "wrist to stow", "park wrist".`,

                // ── Scene switching ────────────────────────────────────────────────────────────────────────
                `When the user wants to change the operator UI scene (not robot motion), call tool \`${SWITCH_SCENE}\` with \`scene\`. Do not call a movement tool. Call this tool even if the utterance is only a scene switch.`,
                `\`scene="pilot"\`: switch to Pilot mode. Phrases: "switch to Pilot", "go to Pilot", "open Pilot", "Pilot mode", "pilot".`,
                `\`scene="autonav"\`: switch to AutoNav scene ONLY for bare scene switches: "switch to AutoNav", "go to AutoNav", "open AutoNav", "AutoNav mode", or a lone "autonav" / "auto-nav" with no place name after it.`,
                `Speech-to-text often mishears AutoNav as "auto now", "auto nav", "auto-nav", or "auto nap". For bare scene switches, treat those as \`scene="autonav"\`.`,
                `CRITICAL: If the utterance is "Navigate to …" / "Navigate to the …" / "navigated to …" followed by a place name, do NOT call \`${SWITCH_SCENE}\` — call \`${LOAD_AUTONAV_LOCATION}\` instead.`,

                // ── Main Menu ──────────────────────────────────────────────────────────────────────────────
                `When the user wants to open or close the operator Main Menu overlay (not change scenes, not Saved Locations), call tool \`${SET_MAIN_MENU}\` with \`action\`. Do not call a movement tool. Do not use \`${SWITCH_SCENE}\` or \`${SET_SAVED_LOCATIONS_MODAL}\` for this.`,
                `\`action="open"\`: Phrases: "Open menu", "Open the menu", "Open main menu", "Show menu", "Show the menu".`,
                `\`action="close"\`: Phrases: "Close menu", "Close the menu", "Close main menu", "Hide menu", "Dismiss menu".`,
                `CRITICAL DISAMBIGUATION: "open menu" / "close menu" → \`${SET_MAIN_MENU}\`. "open AutoNav" / "open Pilot" → \`${SWITCH_SCENE}\`. "open saved locations" → \`${SET_SAVED_LOCATIONS_MODAL}\`.`,

                // ── Save map location ──────────────────────────────────────────────────────────────────────
                `When the user wants to save or bookmark the robot's current place with a name, call tool \`${SAVE_MAP_LOCATION}\` with \`label\`. Do not call a movement tool. Do not ask them to use the Add Location UI.`,
                `Extract the label from phrases like: "add this location as …", "save this spot as …", "name this location …", "save this location as …", "bookmark this as …".`,
                `\`label\` must be the location name only (e.g. "Kitchen", "Docking station"). Do not call the tool if no name was given.`,

                // ── Saved Locations modal ──────────────────────────────────────────────────────────────────
                `When the user wants to open or close the Saved Locations list/modal (not change scenes), call tool \`${SET_SAVED_LOCATIONS_MODAL}\` with \`action\`. Do not call a movement tool. Do not use \`${SWITCH_SCENE}\` for this.`,
                `\`action="open"\`: Phrases: "open saved locations", "show saved locations", "open the locations list", "show my locations".`,
                `\`action="close"\`: Phrases: "close saved locations", "hide saved locations", "close the locations list", "dismiss saved locations".`,
                `CRITICAL DISAMBIGUATION: "open menu" → \`${SET_MAIN_MENU}\`. "open AutoNav" / "go to AutoNav" (no place) → \`${SWITCH_SCENE}\` with \`scene="autonav"\`. "open saved locations" → \`${SET_SAVED_LOCATIONS_MODAL}\` with \`action="open"\`. "Navigate to the living room" / "Navigate to middle of living room" → \`${LOAD_AUTONAV_LOCATION}\`, never \`${SWITCH_SCENE}\`.`,
                `The client rejects this tool if the user is not on AutoNav — do not call \`${SWITCH_SCENE}\` as a substitute.`,

                // ── AutoNav start / cancel ─────────────────────────────────────────────────────────────────
                `When the user wants to start or cancel AutoNav navigation (not change scenes, not halt Pilot motion), call tool \`${CONTROL_AUTONAV}\` with \`action\`. Do not call a movement tool. Do not use \`${SWITCH_SCENE}\` or \`${STOP_MOTION}\` for this.`,
                `\`action="start"\`: Phrases: "Navigation start", "Start navigation", "AutoNav start", "start AutoNav", "start autonav". Requires a loaded pose/goal; the client rejects if none is loaded.`,
                `\`action="cancel"\`: Phrases: "Navigation cancel", "Navigation stop", "Cancel navigation", "Stop navigation", "AutoNav cancel", "AutoNav stop", "cancel AutoNav", "stop AutoNav", "stop autonav". Cancels the current AutoNav goal.`,
                `CRITICAL DISAMBIGUATION: "open AutoNav" / "go to AutoNav" (no place) → \`${SWITCH_SCENE}\`. "Navigation start" / "Start navigation" / "AutoNav start" → \`${CONTROL_AUTONAV}\` start. "Navigation cancel" / "Cancel navigation" / "AutoNav cancel" / "AutoNav stop" → \`${CONTROL_AUTONAV}\` cancel. "Navigate to …" / "Navigate to the …" → \`${LOAD_AUTONAV_LOCATION}\`. Bare "stop" / "cancel" → \`${STOP_MOTION}\` (also cancels AutoNav if navigating).`,
                `The client rejects this tool if the user is not on AutoNav — do not call \`${SWITCH_SCENE}\` as a substitute.`,

                // ── Load Saved Location ────────────────────────────────────────────────────────────────────
                `When the user wants to load a Saved Location pose (not start navigating, not change scenes), call tool \`${LOAD_AUTONAV_LOCATION}\` with \`label\`. Do not call a movement tool. Do not call \`${CONTROL_AUTONAV}\` start. Do not call \`${SWITCH_SCENE}\`.`,
                `ONLY call this tool when the utterance has the required prefix "Navigate to …" or "Navigate to the …" (STT may hear "navigated to …"). Examples: "Navigate to the office", "Navigate to middle of living room", "Navigate to the front of the kitchen island".`,
                `Do NOT call this tool for "go to the office", "take me to the kitchen", "AutoNav to the office", or any phrase missing "Navigate to".`,
                `\`label\` must be the place name only after the prefix (e.g. "office", "middle of living room", "front of the kitchen island"). This only loads the pose/goal marker; the user must say "Navigation start" / "Start navigation" / "AutoNav start" separately to navigate.`,
                `CRITICAL: "Navigate to the living room" → \`${LOAD_AUTONAV_LOCATION}\` with \`label="living room"\`. "Navigate to middle of living room" → \`label="middle of living room"\`. NEVER \`${SWITCH_SCENE}\` for these. Bare "open AutoNav" (no place) → \`${SWITCH_SCENE}\`. "Navigation start" / "Start navigation" / "AutoNav start" → \`${CONTROL_AUTONAV}\` start.`,
            ].join(" "),
            tools: [
                {
                    type: "function",
                    name: EXECUTE_BASE_MOVE,
                    description:
                        "Executes timed holonomic base translation or in-place rotate: forward, backward, strafe left/right, rotate left/right.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: BASE_MOVE_ACTIONS,
                                description:
                                    "Semantic direction mapped to chassis motion (translate or rotate in place).",
                            },
                            speed: {
                                type: "string",
                                enum: VOICE_SPEEDS,
                                description: "Driving speed preset.",
                                default: VOICE_SPEED_DEFAULT,
                            },
                            duration_ms: {
                                type: "integer",
                                description:
                                    `How long to move in milliseconds. ` +
                                    `Use when the user specifies a time (e.g. "for 2 seconds" → 2000). ` +
                                    `Omit if distance_m is set. ` +
                                    `Set to ${VOICE_DURATION_MS_MAX} for continuous motion (no explicit duration or distance given).`,
                                minimum: VOICE_DURATION_MS_MIN,
                                maximum: VOICE_DURATION_MS_MAX,
                                default: VOICE_DURATION_MS_MAX,
                            },
                            distance_m: {
                                type: "number",
                                description:
                                    "Distance to travel in meters for translation actions (forward, backward, strafe). " +
                                    `Valid range: ${VOICE_DISTANCE_M_MIN}-${VOICE_DISTANCE_M_MAX} meters. Omit if duration_ms or rotation_rad is set.`,
                                minimum: VOICE_DISTANCE_M_MIN,
                                maximum: VOICE_DISTANCE_M_MAX,
                            },
                            rotation_rad: {
                                type: "number",
                                description:
                                    "Rotation angle in radians for rotation actions (rotate_left, rotate_right). " +
                                    `Valid range: ${VOICE_ROTATION_RAD_MIN}-${VOICE_ROTATION_RAD_MAX} radians. Omit if duration_ms or distance_m is set.`,
                                minimum: VOICE_ROTATION_RAD_MIN,
                                maximum: VOICE_ROTATION_RAD_MAX,
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: EXECUTE_JOINT_MOVE,
                    description:
                        "Executes a timed arm, lift, wrist, or gripper joint move.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: JOINT_MOVE_ACTIONS,
                                description:
                                    "Semantic joint action: lift/lower, extend/retract, wrist roll/pitch/yaw, or gripper open/close.",
                            },
                            speed: {
                                type: "string",
                                enum: VOICE_SPEEDS,
                                description: "Joint movement speed preset.",
                                default: VOICE_SPEED_DEFAULT,
                            },
                            duration_ms: {
                                type: "integer",
                                description:
                                    `How long to move in milliseconds. ` +
                                    `Required for gripper actions. ` +
                                    `For lift/arm/wrist, use distance instead if the user specifies one. ` +
                                    `Set to ${VOICE_DURATION_MS_MAX} for continuous motion (no explicit duration or distance given).`,
                                minimum: VOICE_DURATION_MS_MIN,
                                maximum: VOICE_DURATION_MS_MAX,
                                default: VOICE_DURATION_MS_MAX,
                            },
                            distance_m: {
                                type: "number",
                                description:
                                    `Distance to travel in meters for lift/arm joint actions (${JOINT_LIFT_ARM_ACTIONS.join("|")}). ` +
                                    `Valid range: ${JOINT_DISTANCE_M_MIN}-${JOINT_DISTANCE_M_MAX} meters. Omit if rotation_rad or duration_ms is set.`,
                                minimum: JOINT_DISTANCE_M_MIN,
                                maximum: JOINT_DISTANCE_M_MAX,
                            },
                            rotation_rad: {
                                type: "number",
                                description:
                                    `Rotation angle in radians for wrist joint actions (${JOINT_WRIST_ACTIONS.join("|")}). ` +
                                    `Valid range: ${JOINT_DISTANCE_RAD_MIN}-${JOINT_DISTANCE_RAD_MAX} radians. Omit if distance_m or duration_ms is set.`,
                                minimum: JOINT_DISTANCE_RAD_MIN,
                                maximum: JOINT_DISTANCE_RAD_MAX,
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                noArgVoiceTool(
                    STOP_MOTION,
                    "Stops ongoing robot motion including base, arm, wrist, and gripper movement. Call when the user wants the robot to stop moving."
                ),
                noArgVoiceTool(
                    REPEAT_BASE_MOVE,
                    "Repeats the last successful voice base move (same direction, speed, duration). No parameters."
                ),
                {
                    type: "function",
                    name: EXECUTE_MACRO,
                    description:
                        "Move the robot to a predefined pose (macro). Use for requests like 'center the wrist' or 'stow the wrist'.",
                    parameters: {
                        type: "object",
                        properties: {
                            macro: {
                                type: "string",
                                enum: VOICE_MACRO_NAMES,
                                description: "Name of the macro to execute.",
                            },
                        },
                        required: ["macro"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: SWITCH_SCENE,
                    description:
                        "Switch the operator UI between Pilot and AutoNav scenes. Use for bare scene switches like 'switch to AutoNav' or 'go to Pilot'. Do NOT use for 'Navigate to …' / 'Navigate to the …' place phrases — those use load_autonav_location.",
                    parameters: {
                        type: "object",
                        properties: {
                            scene: {
                                type: "string",
                                enum: VOICE_SCENE_NAMES,
                                description: "Operator scene to show.",
                            },
                        },
                        required: ["scene"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: SAVE_MAP_LOCATION,
                    description:
                        "Save the robot's current map pose under a user-provided label. Use for requests like 'add this location as Kitchen' or 'save this spot as Docking station'.",
                    parameters: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string",
                                description:
                                    "Name for the saved location (e.g. Kitchen, Docking station).",
                            },
                        },
                        required: ["label"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: SET_MAIN_MENU,
                    description:
                        "Open or close the operator Main Menu overlay. Use for requests like 'Open menu' or 'Close menu'. Do not use for switching Pilot/AutoNav scenes or for Saved Locations.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: MAIN_MENU_ACTIONS,
                                description:
                                    "Whether to open or close the Main Menu.",
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: SET_SAVED_LOCATIONS_MODAL,
                    description:
                        "Open or close the Saved Locations modal in AutoNav. Use for requests like 'open saved locations' or 'close saved locations'. Do not use for switching Pilot/AutoNav scenes.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: SAVED_LOCATIONS_MODAL_ACTIONS,
                                description:
                                    "Whether to open or close the Saved Locations modal.",
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: CONTROL_AUTONAV,
                    description:
                        "Start or cancel AutoNav navigation when a pose/goal is loaded. Use for 'Navigation start', 'Start navigation', 'AutoNav start', 'Navigation cancel', 'Cancel navigation', 'AutoNav cancel', or 'AutoNav stop'. Bare 'stop' should use stop_motion (client also cancels AutoNav if navigating). Do not use for switching Pilot/AutoNav scenes.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: AUTONAV_NAV_ACTIONS,
                                description:
                                    "Whether to start navigation to the loaded pose/goal or cancel the current AutoNav goal.",
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                {
                    type: "function",
                    name: LOAD_AUTONAV_LOCATION,
                    description:
                        "Load a Saved Location pose/goal marker in AutoNav. Use for 'Navigate to …' or 'Navigate to the …' plus a place name (e.g. office, middle of living room). Does not start navigation. Never use switch_scene for these phrases.",
                    parameters: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string",
                                description:
                                    "Place name after 'Navigate to' / 'Navigate to the' (e.g. office, middle of living room).",
                            },
                        },
                        required: ["label"],
                        additionalProperties: false,
                    },
                },
            ],
            tool_choice: "auto",
            // Text-only output: model may call tools / emit text, but must not produce speech.
            // Docs: https://developers.openai.com/api/docs/guides/realtime-conversations
            output_modalities: ["text"],
            audio: {
                input: {
                    transcription: {
                        model: "gpt-4o-transcribe",
                        language: "en",
                        prompt: "Output in English.",
                    },
                    /** Docs: https://developers.openai.com/api/docs/guides/realtime-vad#server-vad  */
                    turn_detection: {
                        type: "server_vad",
                        // How loud and clear incoming audio must be
                        // before the server counts it as speech
                        threshold: 0.5,
                        // When VAD detects speech, OpenAI includes 300ms
                        // of audio from before the trigger point in that turn
                        prefix_padding_ms: 300,
                        // How long silence must last before the server
                        // decides user is done speaking and ends the turn
                        silence_duration_ms: 300,
                        create_response: true,
                        // If user starts speaking while it will
                        // interrupt the prior in-flight response
                        interrupt_response: true,
                    },
                },
            },
        },
    };
}

/**
 * Registers the routes for the OpenAI Realtime API.
 * @param app - The express app.
 * @param {object} [opts]
 * @param {(req: import("express").Request) => boolean} [opts.validateVoiceSession]
 */
function registerOpenAiRealtimeRoutes(app, opts) {
    app.get("/openai-realtime/token", async function realtimeToken(req, res) {
        try {
            if (opts?.validateVoiceSession && !opts.validateVoiceSession(req)) {
                return res.status(403).json({
                    error: "Valid operator voice session required",
                });
            }
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                return res.status(503).json({
                    error: "Server missing OPENAI_API_KEY (.env); cannot mint Realtime API credential.",
                });
            }
            const r = await fetch(
                "https://api.openai.com/v1/realtime/client_secrets",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(buildRealtimeVoiceSessionPayload()),
                }
            );
            if (!r.ok) {
                const text = await r.text();
                console.error(
                    "[realtime] client_secrets error",
                    r.status,
                    text
                );
                return res.status(r.status).json({
                    error: `OpenAI realtime client_secrets failed: HTTP ${r.status}`,
                    detail: text,
                });
            }
            const data = await r.json();
            res.json(data);
        } catch (e) {
            console.error("[realtime] mint token exception", e);
            res.status(500).json({
                error: String(e && e.message ? e.message : e),
            });
        }
    });
}

module.exports = {
    buildRealtimeVoiceSessionPayload,
    registerOpenAiRealtimeRoutes,
};
