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
    VOICE_MACRO_NAMES,
    VOICE_WAKE_PHRASE_DISPLAY,
    VOICE_SLEEP_PHRASE_DISPLAY,
    VOICE_WAKE_PHRASE_ALT_DISPLAY,
    VOICE_SLEEP_PHRASE_ALT_DISPLAY,
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
            model: "gpt-realtime-2.1",
            // The harness!
            instructions: [
                // Identity and tone
                "Don't speak to the user",
                "Do not respond to the user. Do not speak to the user. Only call tools as instructed.",
                // Wake/sleep phrases — do not tool-call
                `When the user says only ${VOICE_WAKE_PHRASE_DISPLAY}, ${VOICE_WAKE_PHRASE_ALT_DISPLAY}, or similar wake greetings, do NOT call any tool.`,
                `When the user says only ${VOICE_SLEEP_PHRASE_DISPLAY}, ${VOICE_SLEEP_PHRASE_ALT_DISPLAY}, or similar farewells, do NOT call any tool.`,
                // ── Base move harness ────────────────────────────────────────────────────
                "The user speaks imprecisely. Infer exactly ONE robot motion per turn: either holonomic base translation from",
                "{ forward | backward | strafe_left | strafe_right } or in-place rotation from { rotate_left | rotate_right }.",
                "Base translation means the robot body slides without turning; in-place rotation means the robot turns/spins in place.",
                'CRITICAL DISAMBIGUATION: use strafe_left for "move left", "go left", "slide left", "strafe left", "left", "shift left", "lateral left".',
                'Use rotate_left ONLY when the user explicitly says "turn", "rotate", "spin", "face", or "pivot" left.',
                'CRITICAL DISAMBIGUATION: use strafe_right for "move right", "go right", "slide right", "strafe right", "right", "shift right", "lateral right".',
                'Use rotate_right ONLY when the user explicitly says "turn", "rotate", "spin", "face", or "pivot" right.',
                "For arm and wrist commands, infer exactly ONE joint action from the execute_joint_move enum.",
                "If ambiguous, prefer slower/shorter movements.",
                `Call tool ${EXECUTE_BASE_MOVE} at most ONCE per user utterance.`,
                `Call tool ${EXECUTE_JOINT_MOVE} at most ONCE per user utterance.`,
                `After a tool result, never call a movement tool again unless the user gives a new command.`,
                `Call tool ${EXECUTE_BASE_MOVE} with action (enum), speed (${VOICE_SPEEDS.join("|")}), and EITHER duration_ms OR distance_m — not both.`,
                `If the user specifies a distance (e.g. "move forward half a meter", "go forward 0.5 meters"), set distance_m in meters (${VOICE_DISTANCE_M_MIN}-${VOICE_DISTANCE_M_MAX}) and omit duration_ms.`,
                `If the user specifies a rotation angle (e.g. "rotate 90 degrees", "turn left a quarter turn"), set distance_m in degrees (e.g. 90) and omit duration_ms.`,
                `If the user specifies an explicit time (e.g. "move forward for 2 seconds"), set duration_ms to that time and omit distance_m.`,
                `If neither distance nor time is specified for base movement, set duration_ms=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says stop).`,
                // ── Joint move harness ───────────────────────────────────────────────────
                `For ${EXECUTE_JOINT_MOVE}, use actions from ${JOINT_MOVE_ACTIONS.join("|")}.`,
                `For lift/arm joint actions (${JOINT_LIFT_ARM_ACTIONS.join("|")}), distance is meters (${JOINT_DISTANCE_M_MIN}-${JOINT_DISTANCE_M_MAX}) and should be passed as distance.`,
                `For wrist joint actions (${JOINT_WRIST_ACTIONS.join("|")}), distance is radians (${JOINT_DISTANCE_RAD_MIN}-${JOINT_DISTANCE_RAD_MAX}) and should be passed as distance.`,
                "For gripper_open and gripper_close, omit distance and use duration_ms.",
                `If neither distance nor time is specified for joint movement, set duration_ms=${VOICE_DURATION_MS_MAX} (continuous — the robot will keep moving until the user says stop). Default speed is ${VOICE_SPEED_DEFAULT}.`,
                // ── Stop / repeat ────────────────────────────────────────────────────────────────────────────
                `When the user wants to halt ANY motion (stop, wait, freeze, do not move, cut that, enough, pause, cancel), call tool ${STOP_MOTION} with no arguments — not a movement tool.`,
                `Call ${STOP_MOTION} IMMEDIATELY whenever the user says any word that indicates stopping, even mid-sentence.`,
                `When the user wants to repeat the last base move (again, same thing, one more time, do that again), call tool ${REPEAT_BASE_MOVE} with no arguments — not ${EXECUTE_BASE_MOVE} with guessed parameters. Ensure you are over 90% confident that the user asked you to repeat previous movement before you move.`,
                // ── Macro actions ──────────────────────────────────────────────────────────────────────────
                `Macro actions move the robot to predefined poses. Call ${EXECUTE_MACRO} with the appropriate macro name.`,
                `macro="center_wrist": centers the wrist to roll=0, pitch=0, yaw=0. Phrases: "center the wrist", "reset wrist", "straighten wrist", "wrist to zero", "zero wrist", "center wrist".`,
                `macro="stow_wrist": moves the wrist to the robot's stow pose. Phrases: "stow the wrist", "stow wrist", "tuck wrist", "wrist to stow", "park wrist".`,
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
                                    "For rotation actions (rotate_left, rotate_right), pass the angle in degrees, e.g. 90 for a quarter turn. " +
                                    `Valid range: translation ${VOICE_DISTANCE_M_MIN}-${VOICE_DISTANCE_M_MAX} meters; ` +
                                    `rotation ${VOICE_ROTATION_DEG_MIN}-${VOICE_ROTATION_DEG_MAX} degrees. Omit if duration_ms is set.`,
                                minimum: VOICE_DISTANCE_M_MIN,
                                maximum: VOICE_ROTATION_DEG_MAX,
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
                            distance: {
                                type: "number",
                                description:
                                    "Distance for lift/arm in meters or wrist angle in radians. " +
                                    `Lift/arm range: ${JOINT_DISTANCE_M_MIN}-${JOINT_DISTANCE_M_MAX} meters. ` +
                                    `Wrist range: ${JOINT_DISTANCE_RAD_MIN}-${JOINT_DISTANCE_RAD_MAX} radians. ` +
                                    "Omit for gripper actions and when duration_ms is set.",
                                minimum: JOINT_DISTANCE_M_MIN,
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
