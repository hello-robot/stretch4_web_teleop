/**
 * This file contains the auth and harness for working with OpenAI Realtime API
 *
 * Builds the Realtime session payload (model, base-move + joint-move tool schemas, VAD config)
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
    VOICE_SPEED_DEFAULT,
    VOICE_SPEEDS,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    REPEAT_BASE_MOVE,
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
    JOINT_DISTANCE_M_MIN,
    JOINT_DISTANCE_M_MAX,
    JOINT_DISTANCE_RAD_MIN,
    JOINT_DISTANCE_RAD_MAX,
    EXECUTE_MACRO,
    VOICE_MACRO_NAMES,
} = require("./constants");

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
            model: "gpt-realtime-2",
            instructions: [
                "Don't speak to the user",
                // ── Base move harness ────────────────────────────────────────────────────
                "The user speaks imprecisely. Infer exactly ONE motion command per turn.",
                `For BASE movement (forward, backward, strafe, rotate), call tool ${EXECUTE_BASE_MOVE}.`,
                "Base actions: { forward | backward | strafe_left | strafe_right } for translation (robot body slides sideways without turning),",
                "{ rotate_left | rotate_right } for in-place rotation (robot turns/spins in place).",
                "CRITICAL DISAMBIGUATION — use strafe_left for: \"move left\", \"go left\", \"slide left\", \"strafe left\", \"left\", \"shift left\", \"lateral left\".",
                "Use rotate_left ONLY when the user explicitly says \"turn\", \"rotate\", \"spin\", \"face\", \"pivot\" left.",
                "CRITICAL DISAMBIGUATION — use strafe_right for: \"move right\", \"go right\", \"slide right\", \"strafe right\", \"right\", \"shift right\", \"lateral right\".",
                "Use rotate_right ONLY when the user explicitly says \"turn\", \"rotate\", \"spin\", \"face\", \"pivot\" right.",
                `Call tool ${EXECUTE_BASE_MOVE} with action (enum), speed (${VOICE_SPEEDS.join("|")}), and EITHER duration_ms OR distance_m — not both.`,
                `If the user specifies a distance (e.g. "move forward half a meter"), set distance_m in meters (${VOICE_DISTANCE_M_MIN}–${VOICE_DISTANCE_M_MAX}) and omit duration_ms.`,
                `If the user specifies a rotation angle (e.g. "rotate 90 degrees"), set distance_m in degrees (e.g. 90) and omit duration_ms.`,
                `If the user specifies an explicit time for base movement, set duration_ms to that time and omit distance_m.`,
                `If neither distance nor time is specified for base movement, set duration_ms=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says stop).`,
                // ── Joint move harness ───────────────────────────────────────────────────
                `For JOINT movement (arm, wrist, gripper), call tool ${EXECUTE_JOINT_MOVE}.`,
                `Lift/arm actions (${JOINT_LIFT_ARM_ACTIONS.join("|")}): EITHER set distance in meters (${JOINT_DISTANCE_M_MIN}–${JOINT_DISTANCE_M_MAX}) OR duration_ms.`,
                `Wrist actions (${JOINT_WRIST_ACTIONS.join("|")}): EITHER set distance in radians (${JOINT_DISTANCE_RAD_MIN}–${JOINT_DISTANCE_RAD_MAX}) OR duration_ms.`,
                `Gripper actions (gripper_open|gripper_close): use duration_ms only — no distance.`,
                `If the user says "lift the arm 0.2 meters", set action=arm_lift, distance=0.2. If they say "open gripper for 1 second", set action=gripper_open, duration_ms=1000.`,
                `If neither distance nor time is specified for joint movement, set duration_ms=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says stop).`,
                // ── Stop / repeat ────────────────────────────────────────────────────────────────────────────
                `When the user wants to halt ANY motion (stop, wait, freeze, enough, pause, cancel), call tool ${STOP_MOTION} with no arguments.`,
                `Call ${STOP_MOTION} IMMEDIATELY whenever the user says any word that indicates stopping, even mid-sentence.`,
                `When the user wants to repeat the last base move (again, same thing, one more time), call tool ${REPEAT_BASE_MOVE} with no arguments. Ensure you are over 90% confident.`,
                // ── Macro actions ──────────────────────────────────────────────────────────────────────────
                `Macro actions move the robot to predefined poses. Call ${EXECUTE_MACRO} with the appropriate macro name.`,
                `macro="center_wrist": sets wrist yaw=0, pitch=0, roll=0. Phrases: "center the wrist", "reset wrist", "straighten wrist", "wrist to zero", "zero wrist", "center wrist".`,
                `macro="stow_wrist": sets wrist yaw=pi/2, pitch=0, roll=0. Phrases: "stow the wrist", "stow wrist", "tuck wrist", "wrist to stow", "park wrist".`,
                // ── Global rules ─────────────────────────────────────────────────────────
                "Call at most ONE tool per user utterance. If ambiguous, prefer slower/shorter movements.",
                "Do not respond to the user. Do not speak to the user. Only call tools as instructed.",
            ].join(" "),
            tools: [
                // ── execute_base_move ────────────────────────────────────────────────────
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
                                    "Distance to travel in meters (for translation actions: forward, backward, strafe). " +
                                    "For rotation actions (rotate_left, rotate_right), pass the angle in degrees (e.g. 90 for a quarter turn). " +
                                    `Valid range: translation (${VOICE_DISTANCE_M_MIN}–${VOICE_DISTANCE_M_MAX} meters), ` +
                                    `rotation (${VOICE_ROTATION_DEG_MIN}–${VOICE_ROTATION_DEG_MAX} degrees). Omit if duration_ms is set.`,
                                minimum: VOICE_DISTANCE_M_MIN,
                                maximum: VOICE_ROTATION_DEG_MAX,
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                // ── execute_joint_move ───────────────────────────────────────────────────
                {
                    type: "function",
                    name: EXECUTE_JOINT_MOVE,
                    description:
                        "Moves a Stretch arm, wrist, or gripper joint by voice command. " +
                        "Lift and arm use meters; wrist uses radians; gripper uses duration only.",
                    parameters: {
                        type: "object",
                        properties: {
                            action: {
                                type: "string",
                                enum: JOINT_MOVE_ACTIONS,
                                description:
                                    "Joint movement action. " +
                                    `Lift/arm: ${JOINT_LIFT_ARM_ACTIONS.join("|")}. ` +
                                    `Wrist: ${JOINT_WRIST_ACTIONS.join("|")}. ` +
                                    "Gripper: gripper_open|gripper_close.",
                            },
                            speed: {
                                type: "string",
                                enum: VOICE_SPEEDS,
                                description: "Movement speed preset.",
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
                            distance: {
                                type: "number",
                                description:
                                    "How far to move. " +
                                    `Lift/arm: meters (${JOINT_DISTANCE_M_MIN}–${JOINT_DISTANCE_M_MAX}). ` +
                                    `Wrist: radians (${JOINT_DISTANCE_RAD_MIN}–${JOINT_DISTANCE_RAD_MAX}). ` +
                                    "Gripper: omit (use duration_ms instead). Omit if duration_ms is set.",
                                minimum: JOINT_DISTANCE_M_MIN,
                                maximum: JOINT_DISTANCE_RAD_MAX,
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                // ── stop_motion ──────────────────────────────────────────────────────────
                noArgVoiceTool(
                    STOP_MOTION,
                    "Stops any ongoing robot motion — base translation, rotation, arm, wrist, or gripper. Call when the user wants all movement to stop."
                ),
                // ── repeat_base_move ─────────────────────────────────────────────────────
                noArgVoiceTool(
                    REPEAT_BASE_MOVE,
                    "Repeats the last successful voice base move (same direction, speed, duration). No parameters."
                ),
                // ── execute_macro ──────────────────────────────────────────────────────────
                {
                    type: "function",
                    name: EXECUTE_MACRO,
                    description: "Move the robot to a predefined pose (macro). Use for requests like 'center the wrist' or 'reset wrist'.",
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
            ],
            tool_choice: "auto",
            audio: {
                input: {
                    turn_detection: {
                        type: "server_vad",
                        threshold: 0.7,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 300,
                        create_response: true,
                        interrupt_response: true,
                    },
                },
                // output: {
                //     voice: "alloy",
                // },
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
