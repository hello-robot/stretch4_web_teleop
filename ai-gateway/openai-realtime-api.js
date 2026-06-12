/**
 * This file contains the auth and harness for working with OpenAI Realtime API
 *
 * Builds the Realtime session payload (model, base-move tool schema, VAD config)
 * and registers `GET /openai-realtime/token`, which mints an ephemeral client secret
 * so the browser can open a WebRTC session without exposing `OPENAI_API_KEY`.
 *
 * Mint requires header `X-Voice-Session-Token` when `opts.validateVoiceSession` is set
 * (local socket.io operator session from `voice-session-auth.js`).
 *
 * Wired into the app by `server.js` via `registerOpenAiRealtimeRoutes(app, opts)`.
 * Shared tool names, duration bounds, and execute_base_move enums live in `./constants.js`.
 */
const {
    BASE_MOVE_ACTIONS,
    BASE_MOVE_SPEED_DEFAULT,
    BASE_MOVE_SPEEDS,
    EXECUTE_BASE_MOVE,
    REPEAT_BASE_MOVE,
    STOP_BASE_MOVE,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_DURATION_MS_MAX,
    VOICE_DURATION_MS_MIN,
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
            model: "gpt-realtime",
            // The harness!
            instructions: [
                // Identity and tone
                // "You are Stretch, the robot's voice for teleoperation (proof of concept).",
                // 'Speak in first person as Stretch (e.g. "I\'ll move forward," not "the robot will").',
                // "If asked your name or who you are, you are Stretch.",
                // "Tone: warm, friendly, and calm — like a helpful teammate. Stay brief: one short sentence for confirmations; plain language, no jargon.",
                // Motion harness
                "Don't speak to the user",
                "The user speaks imprecisely. Infer exactly ONE base motion per turn: either holonomic translation from",
                "{ forward | backward | strafe_left | strafe_right } or in-place rotation from { rotate_left | rotate_right }.",
                "If ambiguous, prefer slower/shorter movements.",
                `Call tool ${EXECUTE_BASE_MOVE} at most ONCE per user utterance.`,
                `After a tool result, confirm warmly in one brief sentence — never call ${EXECUTE_BASE_MOVE} again unless the user gives a new command.`,
                `Call tool ${EXECUTE_BASE_MOVE} with action (enum), speed (${BASE_MOVE_SPEEDS.join("|")}), duration_ms (${VOICE_DURATION_MS_MIN}-${VOICE_DURATION_MS_MAX}).`,
                `Default duration_ms ${VOICE_DURATION_MS_DEFAULT} if unstated; default speed ${BASE_MOVE_SPEED_DEFAULT}.`,
                `When the user wants to halt base motion (stop, wait, freeze, do not move, cut that, enough), call tool ${STOP_BASE_MOVE} with no arguments — not ${EXECUTE_BASE_MOVE}.`,
                `When the user wants to repeat the last base move (again, same thing, one more time, do that again), call tool ${REPEAT_BASE_MOVE} with no arguments — not ${EXECUTE_BASE_MOVE} with guessed parameters. Ensure you are over 90% confident that the user asked you to repeat previous movement before you move.`,
                "Do not respond to the user. Do not speak to the user. Only call tools as instructed.",
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
                                enum: BASE_MOVE_SPEEDS,
                                description: "Driving speed preset.",
                                default: BASE_MOVE_SPEED_DEFAULT,
                            },
                            duration_ms: {
                                type: "integer",
                                description:
                                    "How long to move in milliseconds before stopping.",
                                minimum: VOICE_DURATION_MS_MIN,
                                maximum: VOICE_DURATION_MS_MAX,
                                default: VOICE_DURATION_MS_DEFAULT,
                            },
                        },
                        required: ["action"],
                        additionalProperties: false,
                    },
                },
                noArgVoiceTool(
                    STOP_BASE_MOVE,
                    "Stops ongoing holonomic base motion including translation and rotation (voice timed move or pilot velocity). Call when the user wants the base to stop moving."
                ),
                noArgVoiceTool(
                    REPEAT_BASE_MOVE,
                    "Repeats the last successful voice base move (same direction, speed, duration). No parameters."
                ),
            ],
            tool_choice: "auto",
            audio: {
                input: {
                    turn_detection: {
                        type: "server_vad",
                        threshold: 0.65,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 600,
                        create_response: true,
                        interrupt_response: false,
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