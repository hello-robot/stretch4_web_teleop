/**
 * OpenAI Realtime WebRTC client (speech input and tools-calling only)
 *
 * Docs: https://developers.openai.com/api/docs/guides/realtime-webrtc
 */

import type { ButtonFunctionProvider } from "../function_providers/ButtonFunctionProvider";
import {
    clearLastVoiceBaseMove,
    executeBaseMoveOnProvider,
    executeRepeatBaseMoveOnProvider,
    setVoiceMoveExecutionContext,
} from "./executeBaseMove";
import {
    executeMacroOnProvider,
    executeJointMoveOnProvider,
    executeStopMotionOnProvider,
} from "./executeJointMove";
import {
    executeSaveMapLocation,
    type SaveMapLocationResult,
} from "./executeSaveMapLocation";
import {
    extractLabelAfterNavigateToThe,
    hasNavigateToThePrefix,
    isBareNavigatePhrase,
    isToThePlaceContinuation,
    matchSavedLocation,
} from "./matchSavedLocation";
import { normalizePhrase } from "./phraseUtils";
import {
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    EXECUTE_MACRO,
    SWITCH_SCENE,
    SAVE_MAP_LOCATION,
    SET_SAVED_LOCATIONS_MODAL,
    CONTROL_AUTONAV,
    LOAD_AUTONAV_LOCATION,
    SAVED_LOCATIONS_MODAL_ACTIONS,
    AUTONAV_NAV_ACTIONS,
    isPlaceholderArgs,
    NO_ARG_VOICE_TOOLS,
    STOP_MOTION,
    type ExecuteToolResult,
    type SavedLocationsModalAction,
    type SetSavedLocationsModalResult,
    type ControlAutoNavAction,
    type ControlAutoNavResult,
    type LoadAutoNavLocationResult,
    type VoiceSceneName,
    type VoiceSpeed,
    type VoiceMoveExecutionMode,
    type VoiceToolName,
    VOICE_SCENE_NAMES,
    VOICE_SPEED_DEFAULT,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_TOOLS,
    VOICE_ASLEEP_TOOL_DEFER_MS,
    VOICE_STOP_KEYWORDS,
    VOICE_WAKE_PHRASE_DISPLAY,
    VOICE_WAKE_PHRASE_ALT_DISPLAY,
} from "./constants";
import { createMicLevelGate, type MicLevelGate } from "./micLevelGate";
import { bumpVoiceCommandActivity } from "./voiceCommandActivity";
import {
    createVoiceWakeSleep,
    type VoiceListeningState,
    type VoiceWakeSleep,
} from "./voiceWakeSleep";
import { getOperatorVoiceSessionToken } from "shared/operatorVoiceSession";
import type { VoiceMoveFeedback } from "./voiceMoveFeedback";

const OAI_REALTIME_AUDIO_PATH = "/v1/realtime/calls";
const OAI_REALTIME_HC = "https://api.openai.com";

const sleepMs = (ms: number) =>
    new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
    });

/** Extract user transcript text from Realtime transcription events. */
function extractUserTranscript(blob: Record<string, unknown>): string {
    if (typeof blob.transcript === "string") {
        return blob.transcript;
    }
    if (typeof blob.delta === "string") {
        return blob.delta;
    }
    const item = blob.item as { transcript?: string } | undefined;
    if (typeof item?.transcript === "string") {
        return item.transcript;
    }
    return "";
}

function realtimeHost(): string {
    return OAI_REALTIME_HC;
}

function extractEphemeralKey(tokenJson: Record<string, unknown>): string | null {
    if (typeof tokenJson.value === "string") {
        return tokenJson.value;
    }
    if (typeof tokenJson.client_secret === "string") {
        return tokenJson.client_secret;
    }
    const cs = tokenJson.client_secret as
        | Record<string, unknown>
        | undefined;
    if (cs && typeof cs.value === "string") {
        return cs.value;
    }
    const top = tokenJson as { ephemeral_key?: string };
    if (typeof top.ephemeral_key === "string") {
        return top.ephemeral_key;
    }
    const key = tokenJson as { api_key?: string };
    if (typeof key.api_key === "string") {
        return key.api_key;
    }
    return null;
}

interface ExtractedFnCall {
    call_id: string;
    name: string;
    arguments: string;
}

type ToolCallSource =
    | "function_call_arguments.done"
    | "accumulateFunctionCalls";

/** Event types that may carry nested complete function_call items (fallback path). */
const FALLBACK_FN_CALL_EVENT_TYPES = new Set([
    "response.output_item.done",
    "response.done",
]);

function formatToolCallLog(
    fc: ExtractedFnCall,
    source: ToolCallSource,
): string {
    const ts = new Date().toISOString().slice(11, 23);
    let argsSummary = fc.arguments.slice(0, 120);
    if (fc.name === EXECUTE_BASE_MOVE) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            const summary: Record<string, unknown> = {
                action: parsed.action,
                speed: parsed.speed ?? VOICE_SPEED_DEFAULT,
            };
            if (parsed.distance_m !== undefined && parsed.distance_m !== null) {
                summary.distance_m = parsed.distance_m;
            } else if (parsed.rotation_rad !== undefined && parsed.rotation_rad !== null) {
                summary.rotation_rad = parsed.rotation_rad;
            } else {
                summary.duration_ms = parsed.duration_ms ?? VOICE_DURATION_MS_DEFAULT;
            }
            argsSummary = JSON.stringify(summary);
        } catch {
            //
        }
    } else if (fc.name === EXECUTE_JOINT_MOVE) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            const summary: Record<string, unknown> = {
                action: parsed.action,
                speed: parsed.speed ?? VOICE_SPEED_DEFAULT,
            };
            if (parsed.distance !== undefined && parsed.distance !== null) {
                summary.distance = parsed.distance;
            } else {
                summary.duration_ms = parsed.duration_ms ?? VOICE_DURATION_MS_DEFAULT;
            }
            argsSummary = JSON.stringify(summary);
        } catch {
            //
        }
    } else if (fc.name === EXECUTE_MACRO) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            argsSummary = JSON.stringify({ macro: parsed.macro });
        } catch {
            //
        }
    } else if (fc.name === SWITCH_SCENE) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            argsSummary = JSON.stringify({ scene: parsed.scene });
        } catch {
            //
        }
    } else if (
        fc.name === SET_SAVED_LOCATIONS_MODAL ||
        fc.name === CONTROL_AUTONAV
    ) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            argsSummary = JSON.stringify({ action: parsed.action });
        } catch {
            //
        }
    } else if (fc.name === LOAD_AUTONAV_LOCATION || fc.name === SAVE_MAP_LOCATION) {
        try {
            const parsed = JSON.parse(fc.arguments || "{}") as Record<
                string,
                unknown
            >;
            argsSummary = JSON.stringify({ label: parsed.label });
        } catch {
            //
        }
    }
    return `[Realtime] ${ts} Tool ${fc.name} ${fc.call_id} src=${source} args=${argsSummary}`;
}

function isVoiceToolName(name: string): name is VoiceToolName {
    return (VOICE_TOOLS as readonly string[]).includes(name);
}

function resolveStreamedArgString(fromDoneTrimmed: string, buffered: string): string {
    if (!isPlaceholderArgs(fromDoneTrimmed)) {
        return fromDoneTrimmed;
    }
    if (!isPlaceholderArgs(buffered)) {
        /** `.done.arguments` may be `{}` while deltas streamed the payload (common on mobility clients). */
        return buffered;
    }
    return "";
}

/** Try to record one no-arg tool call from streamed / nested payloads. */
function tryFinalizeNoArgToolCall(
    found: ExtractedFnCall[],
    callId: string,
    nameVal: string,
    argsRaw: string,
): "pushed" | "partial" | "not_no_arg" {
    if (!NO_ARG_VOICE_TOOLS.has(nameVal)) {
        return "not_no_arg";
    }
    const trimmedArgs = argsRaw.trim();
    if (isPlaceholderArgs(trimmedArgs)) {
        found.push({ call_id: callId, name: nameVal, arguments: "{}" });
        return "pushed";
    }
    try {
        JSON.parse(trimmedArgs);
        found.push({ call_id: callId, name: nameVal, arguments: "{}" });
        return "pushed";
    } catch {
        return "partial";
    }
}

function parsedArgsCompleteForTool(
    nameVal: string,
    parsed: Record<string, unknown>,
): boolean {
    if (nameVal === EXECUTE_BASE_MOVE || nameVal === EXECUTE_JOINT_MOVE) {
        return typeof parsed.action === "string" && parsed.action.length > 0;
    }
    if (nameVal === EXECUTE_MACRO) {
        return typeof parsed.macro === "string" && parsed.macro.length > 0;
    }
    if (nameVal === SWITCH_SCENE) {
        return typeof parsed.scene === "string" && parsed.scene.length > 0;
    }
    return false;
}

/** Back-compat shim for stray events carrying a complete function_call item (rare vs .done stream). */
function accumulateFunctionCalls(
    roots: Record<string, unknown>[],
): ExtractedFnCall[] {
    const found: ExtractedFnCall[] = [];

    function visit(node: unknown) {
        if (node === null || node === undefined) {
            return;
        }
        if (typeof node === "string" || typeof node === "number") {
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        const obj = node as Record<string, unknown>;

        const callId = obj.call_id;
        const nameVal = obj.name;
        let argsRaw = obj.arguments;
        /** Some events nest under `tool_call` shape */
        if (argsRaw === undefined && typeof obj.function === "object") {
            const fn = obj.function as Record<string, unknown>;
            argsRaw =
                typeof fn.arguments === "string"
                    ? fn.arguments
                    : typeof fn.arguments === "object"
                        ? JSON.stringify(fn.arguments ?? {})
                        : undefined;
            if (
                typeof callId !== "string" &&
                typeof fn.name === "string" &&
                nameVal === undefined
            ) {
                visit({
                    ...obj,
                    ...fn,
                    name: fn.name,
                    arguments:
                        typeof fn.arguments === "string"
                            ? fn.arguments
                            : JSON.stringify(fn.arguments ?? {}),
                });
                return;
            }
        }

        if (
            typeof callId === "string" &&
            typeof nameVal === "string" &&
            (
                nameVal === EXECUTE_BASE_MOVE ||
                nameVal === EXECUTE_JOINT_MOVE ||
                nameVal === EXECUTE_MACRO ||
                nameVal === SWITCH_SCENE
            ) &&
            typeof argsRaw === "string"
        ) {
            /** Skip placeholder streaming frames ({}); wait for streamed JSON or `.done`. */
            const trimmedArgs = argsRaw.trim();
            if (isPlaceholderArgs(trimmedArgs)) {
                // continue walking for nested payloads
                for (const v of Object.values(obj)) {
                    visit(v);
                }
                return;
            }
            let parsedProb: Record<string, unknown>;
            try {
                parsedProb = JSON.parse(trimmedArgs) as Record<
                    string,
                    unknown
                >;
            } catch {
                /** Partial JSON fragments while streaming traverse nested nodes only */
                for (const v of Object.values(obj)) {
                    visit(v);
                }
                return;
            }
            if (!parsedArgsCompleteForTool(nameVal, parsedProb)) {
                for (const v of Object.values(obj)) {
                    visit(v);
                }
                return;
            }
            found.push({ call_id: callId, name: nameVal, arguments: trimmedArgs });
        } else if (
            typeof callId === "string" &&
            typeof nameVal === "string" &&
            typeof argsRaw === "string"
        ) {
            const noArgState = tryFinalizeNoArgToolCall(
                found,
                callId,
                nameVal,
                argsRaw,
            );
            if (noArgState === "partial") {
                for (const v of Object.values(obj)) {
                    visit(v);
                }
                return;
            }
        }

        for (const v of Object.values(obj)) {
            visit(v);
        }
    }

    for (const root of roots) {
        visit(root);
    }

    /** Dedupe identical call ids (keep latest args) */
    const byCall = new Map<string, ExtractedFnCall>();
    for (const c of found) {
        byCall.set(c.call_id, c);
    }
    return Array.from(byCall.values());
}


function mintTokenErrorMessage(status: number, body: string): string {
    if (status === 403) {
        return "Voice session not authorized — join the robot room as operator first";
    }
    return `Token endpoint HTTP ${status}: ${body.slice(0, 400)}`;
}

async function mintEphemeralCredential(
    tokenUrl: string,
    voiceSessionToken: string,
): Promise<{ key: string; raw: Record<string, unknown> }> {
    const r = await fetch(tokenUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { "X-Voice-Session-Token": voiceSessionToken },
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(mintTokenErrorMessage(r.status, t));
    }
    const raw = (await r.json()) as Record<string, unknown>;
    const key = extractEphemeralKey(raw);
    if (!key) {
        console.warn("[Realtime] Unexpected token payload keys", Object.keys(raw));
        throw new Error("Token response missing ephemeral key (checked value, client_secret.value, …)");
    }
    return { key, raw };
}

/** Send tool result to Realtime without requesting a spoken response. */
function sendFnOutput(
    dc: RTCDataChannel,
    callId: string,
    output: ExecuteToolResult,
) {
    dc.send(
        JSON.stringify({
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify(output),
            },
        }),
    );
}

export type RealtimeVoiceConnectOptions = {
    /** Relative or absolute mint URL (HTTPS same-origin recommended) */
    tokenUrl?: string;
    /** Override socket.io voice session token (tests); default from operatorVoiceSession */
    voiceSessionToken?: string;
    voiceProvider: ButtonFunctionProvider;
    onStatus?: (s: string) => void;
    onLog?: (s: string) => void;
    /**
     * Normalized mic RMS (0–1) and whether the RMS threshold gate is open
     * (for UI). Uplink may still transmit while asleep via wake-sleep bypass
     * even when gateOpen is false.
     */
    onMicLevel?: (level: number, gateOpen: boolean) => void;
    /** Temporary POC: direct timedBaseDrive vs directional pad button path */
    voiceMoveExecutionMode?: VoiceMoveExecutionMode;
    /** Sync Action Speed UI + FunctionProvider.velocityScale from voice `speed` arg */
    onVoiceSpeedChange?: (speed: VoiceSpeed) => void;
    /** Switch operator to Press-Hold before each voice move */
    onVoicePressAndHoldRequired?: () => void;
    /** Structured feedback when a voice move is accepted or rejected (toast UX). */
    onVoiceMoveFeedback?: (feedback: VoiceMoveFeedback) => void;
    /** Switch operator UI scene (Pilot / AutoNav). */
    onSwitchScene?: (scene: VoiceSceneName) => void;
    /** Toast UX after save_map_location succeeds or fails. */
    onSaveMapLocationResult?: (result: SaveMapLocationResult) => void;
    /**
     * Open/close Saved Locations modal (AutoNav-gated in MobileOperator).
     * Return result for tool output; VoiceCommandAssistant toasts errors.
     */
    onSetSavedLocationsModal?: (
        action: SavedLocationsModalAction,
    ) => SetSavedLocationsModalResult;
    /**
     * Start/cancel AutoNav navigation (AutoNav-gated in MobileOperator).
     * Return result for tool output; VoiceCommandAssistant toasts errors.
     */
    onControlAutoNav?: (action: ControlAutoNavAction) => ControlAutoNavResult;
    /**
     * Cancel AutoNav if currently navigating (used by bare stop / stop_motion).
     * No-ops when not navigating; VoiceCommandAssistant toasts success only.
     */
    onCancelAutoNavOnStop?: () => ControlAutoNavResult;
    /**
     * Saved pose names for load_autonav_location matching.
     * Return null when AutoNav controls are unavailable / not on AutoNav.
     */
    onGetAutoNavSavedPoseNames?: () => string[] | null;
    /**
     * Load a resolved Saved Location pose (AutoNav-gated in MobileOperator).
     * VoiceCommandAssistant toasts success only.
     */
    onLoadAutoNavLocation?: (poseName: string) => LoadAutoNavLocationResult;
    /** Asleep/awake listening mode (wake/sleep phrases). */
    onListeningState?: (state: VoiceListeningState) => void;
};

export type ActiveRealtimeVoiceSession = {
    disconnect: () => Promise<void>;
    /** Manual wake when Web Speech API is unavailable. */
    wake: () => void;
    sleep: () => void;
    /** Force-close mic uplink (no audio to OpenAI) while session stays up. */
    setMicMuted: (muted: boolean) => void;
};

export type { VoiceListeningState } from "./voiceWakeSleep";

export async function connectOpenAIRealtimeVoice(
    opts: RealtimeVoiceConnectOptions,
): Promise<ActiveRealtimeVoiceSession> {
    const tokenUrl = opts.tokenUrl ?? "/openai-realtime/token";
    const voiceSessionToken =
        opts.voiceSessionToken ?? getOperatorVoiceSessionToken();
    if (!voiceSessionToken) {
        throw new Error(
            "No operator voice session — join the robot room first",
        );
    }

    opts.onStatus?.("Fetching token…");

    const { key: ephemeralKey } = await mintEphemeralCredential(
        tokenUrl,
        voiceSessionToken,
    );

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        bundlePolicy: "max-bundle",
    });

    pc.ontrack = () => { };

    const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });

    let voiceWakeSleep: VoiceWakeSleep | undefined;

    /** Cleared on wake so trailing STT events from the same utterance are ignored. */
    const transcriptByItem = new Map<string, string>();
    /** Latest completed user transcript (for Navigate-to prefix gate). */
    let lastCompletedUserTranscript = "";
    /**
     * Prior turn was bare "Navigate" / "navigated" — next "to the …" may complete
     * a VAD-split load command.
     */
    let pendingBareNavigatePrefix = false;
    /** Dedupe fast-path + model tool double-fires for the same place. */
    let lastLoadedAutoNavLabel = "";
    let lastLoadedAutoNavAtMs = 0;
    const LOAD_AUTONAV_DEDUPE_MS = 2500;

    /** Prefix may appear in a completed turn or still-streaming partials (tool race). */
    const transcriptHasNavigateToThePrefix = (): boolean => {
        if (hasNavigateToThePrefix(lastCompletedUserTranscript)) {
            return true;
        }
        for (const partial of transcriptByItem.values()) {
            if (hasNavigateToThePrefix(partial)) {
                return true;
            }
        }
        return false;
    };

    const latestUserTranscriptForLog = (): string => {
        if (transcriptByItem.size > 0) {
            return [...transcriptByItem.values()].join(" ");
        }
        return lastCompletedUserTranscript;
    };

    const tryLoadAutoNavLocationLabel = (
        label: string,
        source: string,
    ): ExecuteToolResult => {
        const trimmed = label.trim();
        if (!trimmed) {
            return {
                ok: false,
                detail: "Missing location label.",
                ignored: true,
            };
        }
        if (voiceWakeSleep?.state === "asleep") {
            return {
                ok: false,
                detail: `Voice asleep — say "${VOICE_WAKE_PHRASE_DISPLAY}" or "${VOICE_WAKE_PHRASE_ALT_DISPLAY}" to wake.`,
                ignored: true,
            };
        }
        if (
            !opts.onGetAutoNavSavedPoseNames ||
            !opts.onLoadAutoNavLocation
        ) {
            return {
                ok: false,
                detail: "AutoNav location loading is unavailable.",
                ignored: true,
            };
        }
        const poseNames = opts.onGetAutoNavSavedPoseNames();
        if (poseNames === null) {
            return {
                ok: false,
                detail: "AutoNav location loading is unavailable.",
                ignored: true,
            };
        }
        const match = matchSavedLocation(trimmed, poseNames);
        if (match.kind !== "unique") {
            opts.onLog?.(
                `[Realtime] ${LOAD_AUTONAV_LOCATION} ignored (${source}) — ${match.kind} match for "${trimmed}"`,
            );
            return {
                ok: false,
                detail:
                    match.kind === "ambiguous"
                        ? `Ambiguous location: "${trimmed}".`
                        : `Unknown location: "${trimmed}".`,
                ignored: true,
            };
        }
        const now = Date.now();
        if (
            match.name === lastLoadedAutoNavLabel &&
            now - lastLoadedAutoNavAtMs < LOAD_AUTONAV_DEDUPE_MS
        ) {
            opts.onLog?.(
                `[Realtime] ${LOAD_AUTONAV_LOCATION} deduped (${source}) — "${match.name}"`,
            );
            return {
                ok: true,
                detail: `Already loaded "${match.name}".`,
            };
        }
        const result = opts.onLoadAutoNavLocation(match.name);
        if (result.ok) {
            lastLoadedAutoNavLabel = match.name;
            lastLoadedAutoNavAtMs = now;
            opts.onLog?.(
                `[Realtime] ${LOAD_AUTONAV_LOCATION} ok (${source}) — "${match.name}"`,
            );
            return { ok: true, detail: result.detail };
        }
        return { ok: false, detail: result.detail, ignored: true };
    };

    /** Client-side load when STT has "Navigate to …" / "Navigate to the …". */
    const tryFastPathLoadAutoNavLocation = (transcript: string): boolean => {
        let label = extractLabelAfterNavigateToThe(transcript);
        if (
            !label &&
            pendingBareNavigatePrefix &&
            isToThePlaceContinuation(transcript)
        ) {
            label = normalizePhrase(transcript)
                .replace(/^to the\s+/, "")
                .replace(/^to\s+/, "")
                .trim();
        }
        if (!label) {
            return false;
        }
        opts.onLog?.(
            `[Realtime] Fast-path ${LOAD_AUTONAV_LOCATION} from transcript: "${transcript.trim()}" → label="${label}"`,
        );
        tryLoadAutoNavLocationLabel(label, "transcript_fast_path");
        pendingBareNavigatePrefix = false;
        return true;
    };

    voiceWakeSleep = createVoiceWakeSleep({
        provider: opts.voiceProvider,
        onStateChange: (s) => {
            opts.onListeningState?.(s);
            if (s === "awake") {
                transcriptByItem.clear();
                pendingBareNavigatePrefix = false;
            }
        },
        onLog: opts.onLog,
    });
    voiceWakeSleep.start();

    let micGate: MicLevelGate | undefined;

    micGate = await createMicLevelGate(ms, {
        bypassGate: () => voiceWakeSleep?.state === "asleep",
        onGateChange: (gateOpen, level) => {
            opts.onMicLevel?.(level, gateOpen);
        },
    });

    if (
        opts.onVoiceSpeedChange &&
        opts.onVoicePressAndHoldRequired
    ) {
        const baseFeedback = opts.onVoiceMoveFeedback;
        setVoiceMoveExecutionContext({
            mode: opts.voiceMoveExecutionMode ?? "button_provider",
            onSpeedChange: opts.onVoiceSpeedChange,
            onPressAndHoldRequired: opts.onVoicePressAndHoldRequired,
            onVoiceMoveFeedback: (feedback) => {
                if (
                    feedback.kind === "move_started" ||
                    feedback.kind === "macro_started"
                ) {
                    bumpVoiceCommandActivity();
                }
                baseFeedback?.(feedback);
            },
        });
    } else {
        setVoiceMoveExecutionContext(undefined);
    }

    for (const t of micGate.transmitStream.getAudioTracks()) {
        pc.addTrack(t, micGate.transmitStream);
    }

    opts.onStatus?.("Negotiating WebRTC…");

    const dc = pc.createDataChannel("oai-events");

    const processedCalls = new Set<string>();

    /** `call_id` → streamed JSON substring from `response.function_call_arguments.delta`. */
    const fcArgFragments = new Map<string, string>();

    const voiceToolRunners: Record<
        VoiceToolName,
        (
            voiceProvider: ButtonFunctionProvider,
            fc: ExtractedFnCall,
        ) => ExecuteToolResult
    > = {
        execute_base_move: (voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            return executeBaseMoveOnProvider(voiceProvider, rawArgs);
        },
        execute_joint_move: (voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            return executeJointMoveOnProvider(voiceProvider, rawArgs);
        },
        stop_motion: (voiceProvider) => {
            const stopResult = executeStopMotionOnProvider(voiceProvider);
            const cancelResult = opts.onCancelAutoNavOnStop?.();
            if (cancelResult?.ok) {
                return {
                    ok: true,
                    detail: stopResult.ok
                        ? `${stopResult.detail} Cancelled AutoNav.`
                        : cancelResult.detail,
                };
            }
            return stopResult;
        },
        repeat_base_move: (voiceProvider) =>
            executeRepeatBaseMoveOnProvider(voiceProvider),
        execute_macro: (voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for execute_macro: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            return executeMacroOnProvider(voiceProvider, rawArgs);
        },
        switch_scene: (_voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for switch_scene: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            const scene = typeof rawArgs.scene === "string" ? rawArgs.scene : "";
            if (!(VOICE_SCENE_NAMES as readonly string[]).includes(scene)) {
                return {
                    ok: false,
                    detail: `Unknown scene: "${scene}".`,
                    ignored: true,
                };
            }
            // Safety net: if Navigate-to-the is in the transcript, load instead.
            if (scene === "autonav" && transcriptHasNavigateToThePrefix()) {
                const label =
                    extractLabelAfterNavigateToThe(
                        lastCompletedUserTranscript,
                    ) ||
                    [...transcriptByItem.values()]
                        .map((t) => extractLabelAfterNavigateToThe(t))
                        .find((l) => Boolean(l)) ||
                    "";
                if (label) {
                    opts.onLog?.(
                        `[Realtime] Redirecting switch_scene→${LOAD_AUTONAV_LOCATION} label="${label}"`,
                    );
                    return tryLoadAutoNavLocationLabel(
                        label,
                        "switch_scene_redirect",
                    );
                }
            }
            if (!opts.onSwitchScene) {
                return {
                    ok: false,
                    detail: "Scene switching is unavailable.",
                    ignored: true,
                };
            }
            opts.onSwitchScene(scene as VoiceSceneName);
            return { ok: true, detail: `Switched to ${scene}.` };
        },
        save_map_location: (_voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for ${SAVE_MAP_LOCATION}: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            const result = executeSaveMapLocation(rawArgs);
            opts.onSaveMapLocationResult?.({
                ok: result.ok,
                label: result.label,
                detail: result.detail,
            });
            return result;
        },
        set_saved_locations_modal: (_voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for ${SET_SAVED_LOCATIONS_MODAL}: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            const action =
                typeof rawArgs.action === "string" ? rawArgs.action : "";
            if (
                !(SAVED_LOCATIONS_MODAL_ACTIONS as readonly string[]).includes(
                    action,
                )
            ) {
                return {
                    ok: false,
                    detail: `Unknown action: "${action}".`,
                    ignored: true,
                };
            }
            if (!opts.onSetSavedLocationsModal) {
                return {
                    ok: false,
                    detail: "Saved Locations modal is unavailable.",
                    ignored: true,
                };
            }
            const result = opts.onSetSavedLocationsModal(
                action as SavedLocationsModalAction,
            );
            return result.ok
                ? { ok: true, detail: result.detail }
                : { ok: false, detail: result.detail, ignored: true };
        },
        control_autonav: (_voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for ${CONTROL_AUTONAV}: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            const action =
                typeof rawArgs.action === "string" ? rawArgs.action : "";
            if (!(AUTONAV_NAV_ACTIONS as readonly string[]).includes(action)) {
                return {
                    ok: false,
                    detail: `Unknown action: "${action}".`,
                    ignored: true,
                };
            }
            if (!opts.onControlAutoNav) {
                return {
                    ok: false,
                    detail: "AutoNav controls are unavailable.",
                    ignored: true,
                };
            }
            const result = opts.onControlAutoNav(
                action as ControlAutoNavAction,
            );
            return result.ok
                ? { ok: true, detail: result.detail }
                : { ok: false, detail: result.detail, ignored: true };
        },
        load_autonav_location: (_voiceProvider, fc) => {
            let rawArgs: Record<string, unknown>;
            try {
                rawArgs = JSON.parse(fc.arguments || "{}") as Record<
                    string,
                    unknown
                >;
            } catch {
                opts.onLog?.(
                    `[Realtime] Bad JSON arguments for ${LOAD_AUTONAV_LOCATION}: ${fc.arguments}`,
                );
                rawArgs = {};
            }
            const label =
                typeof rawArgs.label === "string" ? rawArgs.label.trim() : "";
            if (!label) {
                return {
                    ok: false,
                    detail: "Missing location label.",
                    ignored: true,
                };
            }
            if (
                !transcriptHasNavigateToThePrefix() &&
                !pendingBareNavigatePrefix
            ) {
                const transcript = latestUserTranscriptForLog();
                opts.onLog?.(
                    `[Realtime] ${LOAD_AUTONAV_LOCATION} ignored — missing Navigate to prefix (transcript="${transcript.slice(0, 80)}")`,
                );
                return {
                    ok: false,
                    detail: 'Requires "Navigate to …" or "Navigate to the …".',
                    ignored: true,
                };
            }
            return tryLoadAutoNavLocationLabel(label, "tool");
        },
    };

    /** `item_id` → accumulated transcript from streaming deltas. */
    const handleUserTranscription = (
        blob: Record<string, unknown>,
        eventType: string,
    ) => {
        const itemId =
            typeof blob.item_id === "string" ? blob.item_id : "_default";

        if (eventType === "conversation.item.input_audio_transcription.failed") {
            const err =
                typeof (blob.error as { message?: string } | undefined)
                    ?.message === "string"
                    ? (blob.error as { message: string }).message
                    : "unknown";
            opts.onLog?.(`[Realtime] user transcription failed: ${err}`);
            transcriptByItem.delete(itemId);
            return;
        }

        if (eventType === "conversation.item.input_audio_transcription.delta") {
            const delta = extractUserTranscript(blob);
            if (!delta) {
                return;
            }
            const next = (transcriptByItem.get(itemId) ?? "") + delta;
            transcriptByItem.set(itemId, next);
            opts.onLog?.(
                `[Realtime] user transcript (partial): ${next.slice(0, 160)}`,
            );
            voiceWakeSleep?.tryPhraseFromTranscript(next, false);
            return;
        }

        if (eventType !== "conversation.item.input_audio_transcription.completed") {
            return;
        }

        const transcript =
            extractUserTranscript(blob) || transcriptByItem.get(itemId) || "";
        transcriptByItem.delete(itemId);
        if (!transcript) {
            return;
        }
        lastCompletedUserTranscript = transcript;
        opts.onLog?.(
            `[Realtime] user transcript: ${transcript.slice(0, 160)}`,
        );
        voiceWakeSleep?.tryPhraseFromTranscript(transcript, true);

        if (voiceWakeSleep?.state === "awake") {
            if (tryFastPathLoadAutoNavLocation(transcript)) {
                // loaded (or attempted) from "Navigate to …" / stitched turn
            } else if (isBareNavigatePhrase(transcript)) {
                pendingBareNavigatePrefix = true;
                opts.onLog?.(
                    `[Realtime] Bare Navigate phrase — waiting for possible "to …" continuation`,
                );
            } else if (!isToThePlaceContinuation(transcript)) {
                pendingBareNavigatePrefix = false;
            }
        }
    };

    const runVoiceToolOnce = async (
        fc: ExtractedFnCall,
        source: ToolCallSource,
    ) => {
        if (processedCalls.has(fc.call_id)) {
            return;
        }
        processedCalls.add(fc.call_id);
        opts.onLog?.(formatToolCallLog(fc, source));

        if (
            voiceWakeSleep?.state === "asleep" &&
            fc.name !== STOP_MOTION
        ) {
            await sleepMs(VOICE_ASLEEP_TOOL_DEFER_MS);
        }

        if (voiceWakeSleep?.shouldIgnoreErroneousToolAfterPhraseWake()) {
            const ignored: ExecuteToolResult = {
                ok: false,
                detail: "Ignored — wake phrase only (no movement).",
                ignored: true,
            };
            opts.onLog?.(
                `[Realtime] Tool result ${JSON.stringify(ignored)} (${fc.call_id})`,
            );
            if (dc.readyState === "open") {
                sendFnOutput(dc, fc.call_id, ignored);
            }
            return;
        }

        const asleep = voiceWakeSleep?.state === "asleep";
        if (asleep && fc.name !== STOP_MOTION) {
            const ignored: ExecuteToolResult = {
                ok: false,
                detail: `Voice asleep — say "${VOICE_WAKE_PHRASE_DISPLAY}" or "${VOICE_WAKE_PHRASE_ALT_DISPLAY}" to wake.`,
                ignored: true,
            };
            opts.onLog?.(
                `[Realtime] Tool result ${JSON.stringify(ignored)} (${fc.call_id})`,
            );
            if (dc.readyState === "open") {
                sendFnOutput(dc, fc.call_id, ignored);
            }
            return;
        }

        const result: ExecuteToolResult = !isVoiceToolName(fc.name)
            ? {
                ok: false,
                detail: `Unknown tool: ${fc.name}`,
                ignored: true,
            }
            : voiceToolRunners[fc.name](opts.voiceProvider, fc);

        if (result.ok) {
            bumpVoiceCommandActivity();
        }

        opts.onLog?.(
            `[Realtime] Tool result ${JSON.stringify(result)} (${fc.call_id})`,
        );
        if (dc.readyState === "open") {
            sendFnOutput(dc, fc.call_id, result);
        }
    };

    const handleRealtimeDataMessage = async (blob: Record<string, unknown>) => {
        const eventType = String(blob.type ?? "");

        if (eventType.includes("input_audio_transcription")) {
            handleUserTranscription(blob, eventType);
            if (voiceWakeSleep?.state !== "awake") {
                return;
            }
            const transcript =
                extractUserTranscript(blob) ||
                transcriptByItem.get(
                    typeof blob.item_id === "string" ? blob.item_id : "_default",
                ) ||
                "";
            if (
                eventType ===
                "conversation.item.input_audio_transcription.completed" &&
                transcript
            ) {
                // ── Interrupt policy: intentional stop only ───────────────────────────────────
                // Motion continues through non-command speech and VAD speech_started.
                // Local stop here only for short transcripts matching VOICE_STOP_KEYWORDS;
                // otherwise wait for stop_motion or a superseding movement tool.
                const words = transcript.trim().toLowerCase().split(/\s+/);
                if (
                    words.length <= 3 &&
                    words.some((w) => VOICE_STOP_KEYWORDS.has(w))
                ) {
                    opts.onLog?.(
                        `[Realtime] Fast-path stop triggered by transcript: "${transcript.trim()}"`,
                    );
                    executeStopMotionOnProvider(opts.voiceProvider);
                    opts.onCancelAutoNavOnStop?.();
                }
            }
            return;
        }

        /** Streamed tool args (`response.function_call_arguments.delta`), finish on `.done`. */
        if (blob.type === "response.function_call_arguments.delta") {
            const cid =
                typeof blob.call_id === "string" ? blob.call_id : "";
            if (!cid) {
                return;
            }
            const delta =
                typeof blob.delta === "string" ? blob.delta : "";
            fcArgFragments.set(cid, (fcArgFragments.get(cid) ?? "") + delta);
            return;
        }

        if (blob.type === "response.function_call_arguments.done") {
            const cid =
                typeof blob.call_id === "string" ? blob.call_id : "";
            const fname =
                typeof blob.name === "string" ? blob.name : "";

            const fromDone =
                typeof blob.arguments === "string"
                    ? blob.arguments.trim()
                    : "";
            const buffered = (fcArgFragments.get(cid) ?? "").trim();
            fcArgFragments.delete(cid);

            const argStr = resolveStreamedArgString(fromDone, buffered);

            if (!cid || !isVoiceToolName(fname)) {
                return;
            }

            if (isPlaceholderArgs(argStr)) {
                if (NO_ARG_VOICE_TOOLS.has(fname)) {
                    await runVoiceToolOnce(
                        {
                            call_id: cid,
                            name: fname,
                            arguments: "{}",
                        },
                        "function_call_arguments.done",
                    );
                    return;
                }
                if (processedCalls.has(cid)) {
                    return;
                }
                processedCalls.add(cid);
                const dead: ExecuteToolResult = {
                    ok: false,
                    detail:
                        "Empty or interrupted voice tool arguments (Realtime .done emitted before streaming finished).",
                    ignored: true,
                };
                opts.onLog?.(
                    `[Realtime] Tool result ${JSON.stringify(dead)} (${cid})`,
                );
                if (dc.readyState === "open") {
                    sendFnOutput(dc, cid, dead);
                }
                return;
            }

            await runVoiceToolOnce(
                {
                    call_id: cid,
                    name: fname,
                    arguments: argStr,
                },
                "function_call_arguments.done",
            );
            return;
        }

        /** Rare: nested `function_call` item with complete args on `response.output_item.done` etc. */
        if (!FALLBACK_FN_CALL_EVENT_TYPES.has(eventType)) {
            return;
        }
        const calls = accumulateFunctionCalls([blob]);
        for (const fc of calls) {
            await runVoiceToolOnce(fc, "accumulateFunctionCalls");
        }
    };

    dc.addEventListener("message", async (evt) => {
        try {
            const rawTxt = evt.data?.toString();
            if (!rawTxt) {
                return;
            }
            const blob = JSON.parse(rawTxt) as Record<string, unknown>;

            opts.onLog?.(`[Realtime] ${String(blob.type)}`);

            await handleRealtimeDataMessage(blob);
        } catch (e) {
            opts.onLog?.(`[Realtime] parse/channel error ${String(e)}`);
        }
    });

    dc.addEventListener("open", () => {
        opts.onStatus?.(
            `Data channel ready — say ${VOICE_WAKE_PHRASE_DISPLAY} or ${VOICE_WAKE_PHRASE_ALT_DISPLAY} to wake`,
        );
        (window as any).spoofVoiceCommand = (text: string) => {
            if (dc.readyState !== "open") {
                console.error("[Spoof] Voice connection is not open.");
                return;
            }
            console.log(`[Spoof] Sending text command: "${text}"`);
            dc.send(
                JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: text,
                            },
                        ],
                    },
                }),
            );
            dc.send(JSON.stringify({ type: "response.create" }));
        };
    });

    const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(
        `${realtimeHost()}${OAI_REALTIME_AUDIO_PATH}`,
        {
            method: "POST",
            body: pc.localDescription?.sdp ?? offer.sdp,
            headers: {
                Authorization: `Bearer ${ephemeralKey}`,
                "Content-Type": "application/sdp",
            },
        },
    );

    if (!sdpResp.ok) {
        const errTxt = await sdpResp.text();
        voiceWakeSleep?.stop();
        voiceWakeSleep = undefined;
        micGate?.stop();
        ms.getTracks().forEach((t) => {
            t.stop();
        });
        pc.close();
        throw new Error(
            `Realtime WebRTC SDP failed HTTP ${sdpResp.status}: ${errTxt.slice(0, 512)}`,
        );
    }

    const answer = {
        type: "answer" as const,
        sdp: await sdpResp.text(),
    };
    await pc.setRemoteDescription(answer);

    opts.onStatus?.("Connected (Realtime)");

    async function disconnect() {
        delete (window as any).spoofVoiceCommand;
        voiceWakeSleep?.stop();
        voiceWakeSleep = undefined;
        micGate?.stop();
        micGate?.transmitStream.getTracks().forEach((t) => {
            t.stop();
        });
        micGate = undefined;
        setVoiceMoveExecutionContext(undefined);
        clearLastVoiceBaseMove();
        dc.close();
        ms.getTracks().forEach((t) => {
            t.stop();
        });
        pc.close();
        opts.onStatus?.("Disconnected");
    }

    return {
        disconnect,
        wake: () => voiceWakeSleep?.wake(),
        sleep: () => voiceWakeSleep?.sleep("phrase"),
        setMicMuted: (muted: boolean) => {
            micGate?.setForceClosed(muted);
        },
    };
}
