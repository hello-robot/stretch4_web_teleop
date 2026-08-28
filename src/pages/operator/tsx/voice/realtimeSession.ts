/**
 * OpenAI Realtime WebRTC client (speech input and tools-calling only)
 *
 * Docs: https://developers.openai.com/api/docs/guides/realtime-webrtc
 */

import {
    getOperatorLogSvc,
    getOperatorVoiceSessionToken,
} from "shared/operatorVoiceSession";
import type { ButtonFunctionProvider } from "../function_providers/ButtonFunctionProvider";
import {
    AUTONAV_NAV_ACTIONS,
    CONTROL_AUTONAV,
    EXECUTE_BASE_MOVE,
    EXECUTE_JOINT_MOVE,
    EXECUTE_MACRO,
    isPlaceholderArgs,
    LOAD_AUTONAV_LOCATION,
    MIC_HEALTH_STATUS_SLUG,
    NO_ARG_VOICE_TOOLS,
    SAVE_MAP_LOCATION,
    SAVED_LOCATIONS_MODAL_ACTIONS,
    SET_SAVED_LOCATIONS_MODAL,
    STOP_MOTION,
    SWITCH_SCENE,
    VOICE_ASLEEP_TOOL_DEFER_MS,
    VOICE_CLIP_SAMPLE_RATE,
    VOICE_CLIP_SILENCE_RMS,
    VOICE_CLIP_START_LOOKBACK_MS,
    VOICE_DURATION_MS_DEFAULT,
    VOICE_SCENE_NAMES,
    VOICE_SPEED_DEFAULT,
    VOICE_STOP_KEYWORDS,
    VOICE_TOOLS,
    VOICE_WAKE_PHRASE_ALT_DISPLAY,
    VOICE_WAKE_PHRASE_DISPLAY,
    type ControlAutoNavAction,
    type ControlAutoNavResult,
    type ExecuteToolResult,
    type LoadAutoNavLocationResult,
    type SavedLocationsModalAction,
    type SetSavedLocationsModalResult,
    type VoiceMoveExecutionMode,
    type VoiceSceneName,
    type VoiceSpeed,
    type VoiceToolName,
} from "./constants";
import {
    clearLastVoiceBaseMove,
    executeBaseMoveOnProvider,
    executeRepeatBaseMoveOnProvider,
    setVoiceMoveExecutionContext,
} from "./executeBaseMove";
import {
    executeJointMoveOnProvider,
    executeMacroOnProvider,
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
import {
    createMicLevelGate,
    type MicLevelGate,
    type UplinkRingMark,
} from "./micLevelGate";
import { normalizePhrase } from "./phraseUtils";
import {
    emitMicEvent,
    emitVoiceAudioClip,
    emitVoiceInteraction,
} from "./voiceInteractionEmitter";
import type { VoiceMoveFeedback } from "./voiceMoveFeedback";
import {
    createVoiceWakeSleep,
    type VoiceListeningState,
    type VoiceWakeSleep,
} from "./voiceWakeSleep";

/** Log metadata for optional uplink Opus join (item_id / VAD ms). */
export type VoiceLogMeta = {
    item_id?: string;
    audio_start_ms?: number;
    audio_end_ms?: number;
};

/** Downsample float32 PCM to Int16 LE at targetRate (linear). */
function downsampleFloat32ToInt16(
    input: Float32Array,
    fromRate: number,
    toRate: number,
): Int16Array {
    if (input.length === 0 || fromRate <= 0 || toRate <= 0) {
        return new Int16Array(0);
    }
    if (fromRate === toRate) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i] ?? 0));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }
    const ratio = fromRate / toRate;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const s = Math.max(
            -1,
            Math.min(1, input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0),
        );
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function float32Rms(samples: Float32Array): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i] ?? 0;
        sum += s * s;
    }
    return Math.sqrt(sum / samples.length);
}

const OAI_REALTIME_AUDIO_PATH = "/v1/realtime/calls";
const OAI_REALTIME_HC = "https://api.openai.com";

export type MicHealthStatusEvent =
    | "User access granted"
    | "User access rejected"
    | "Connected"
    | "Disconnected"
    | "Muted"
    | "Unmuted";

/** Last logged privilege — avoids spam on connect-retry after denial. */
let lastMicPrivilege: "granted" | "rejected" | null = null;
/** Last logged capture connectedness (live input track). */
let lastMicCaptureConnected: boolean | null = null;

export function logMicHealthStatus(event: MicHealthStatusEvent): void {
    console.log(`${MIC_HEALTH_STATUS_SLUG} ${event}`);
    emitMicEvent({ event });
}

function logMicPrivilege(granted: boolean): void {
    const next = granted ? "granted" : "rejected";
    if (lastMicPrivilege === next) {
        return;
    }
    lastMicPrivilege = next;
    logMicHealthStatus(
        granted ? "User access granted" : "User access rejected",
    );
}

function logMicCaptureConnected(connected: boolean): void {
    if (lastMicCaptureConnected === connected) {
        return;
    }
    lastMicCaptureConnected = connected;
    logMicHealthStatus(connected ? "Connected" : "Disconnected");
}

function isMicPermissionDenied(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
    );
}

function streamHasLiveAudio(stream: MediaStream): boolean {
    return stream
        .getAudioTracks()
        .some((t) => t.readyState === "live");
}

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
    } else if (
        fc.name === LOAD_AUTONAV_LOCATION ||
        fc.name === SAVE_MAP_LOCATION
    ) {
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
    if (
        nameVal === SAVE_MAP_LOCATION ||
        nameVal === LOAD_AUTONAV_LOCATION
    ) {
        return typeof parsed.label === "string" && parsed.label.length > 0;
    }
    if (
        nameVal === SET_SAVED_LOCATIONS_MODAL ||
        nameVal === CONTROL_AUTONAV
    ) {
        return typeof parsed.action === "string" && parsed.action.length > 0;
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
                nameVal === SWITCH_SCENE ||
                nameVal === SAVE_MAP_LOCATION ||
                nameVal === SET_SAVED_LOCATIONS_MODAL ||
                nameVal === CONTROL_AUTONAV ||
                nameVal === LOAD_AUTONAV_LOCATION
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

/** Same constraints for first connect and later reacquire. */
const MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};

/** getUserMedia with privilege transition logs (granted / rejected only). */
async function getUserMediaWithPrivilegeLog(): Promise<MediaStream> {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: MIC_AUDIO_CONSTRAINTS,
        });
        logMicPrivilege(true);
        return stream;
    } catch (error) {
        if (isMicPermissionDenied(error)) {
            logMicPrivilege(false);
        }
        throw error;
    }
}

function isIosLike(): boolean {
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) {
        return true;
    }
    // iPadOS 13+ can report as MacIntel with touch.
    return (
        navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
    );
}

/**
 * Home-screen / standalone PWA on iOS.
 * Control Center and App Switcher background these harder than a Safari tab,
 * and the mic AudioContext / getUserMedia graph often dies.
 */
function isIosStandalonePwa(): boolean {
    if (!isIosLike()) {
        return false;
    }
    const nav = navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) {
        return true;
    }
    return window.matchMedia("(display-mode: standalone)").matches;
}

export type RealtimeVoiceConnectOptions = {
    /** Relative or absolute mint URL (HTTPS same-origin recommended) */
    tokenUrl?: string;
    /** Override socket.io voice session token (tests); default from operatorVoiceSession */
    voiceSessionToken?: string;
    voiceProvider: ButtonFunctionProvider;
    onStatus?: (s: string) => void;
    onLog?: (s: string, meta?: VoiceLogMeta) => void;
    /** Normalized mic RMS (0–1) and whether the volume gate is transmitting. */
    onMicLevel?: (level: number, gateOpen: boolean) => void;
    /**
     * Fired when we reset SVC to cold-start (muted + asleep) on mic reacquire /
     * failure. Caller syncs UI and cancels AutoNav without a toast.
     */
    onMicSafeReset?: () => void;
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
    /**
     * Recover mic after foreground, or from Unmute.
     * Serializes concurrent calls. `fromUserGesture: true` skips the safe-reset
     * so Unmute doesn't immediately mute/sleep again.
     */
    recoverMic: (opts?: { fromUserGesture?: boolean }) => Promise<void>;
};

export type RecoverMicOptions = {
    /** Unmute path — keep operator mute/wake intent; start getUserMedia in-gesture. */
    fromUserGesture?: boolean;
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

    let inputStream = await navigator.mediaDevices.getUserMedia({
        audio: MIC_AUDIO_CONSTRAINTS,
    });

    const syncMicCaptureFromInputStream = () => {
        logMicCaptureConnected(streamHasLiveAudio(inputStream));
    };
    const bindInputStreamEnded = (stream: MediaStream) => {
        for (const track of stream.getAudioTracks()) {
            track.addEventListener("ended", () => {
                if (stream !== inputStream) {
                    return;
                }
                syncMicCaptureFromInputStream();
            });
        }
    };
    bindInputStreamEnded(inputStream);
    syncMicCaptureFromInputStream();


    let voiceWakeSleep: VoiceWakeSleep | undefined;

    /** Cleared on wake so trailing STT events from the same utterance are ignored. */
    const transcriptByItem = new Map<string, string>();
    /**
     * Item that last updated the user transcript (delta or completed — not
     * speech_started). Tool joins use this so a tool that fires before
     * transcription.completed still gets the in-flight clip, while a later
     * speech_started cannot overwrite the join.
     */
    let lastTranscriptItemId = "";
    const logSvc = getOperatorLogSvc();

    /** item_id → uplink ring mark (speech_started). Only when --log-svc. */
    const uplinkMarks = logSvc
        ? new Map<string, UplinkRingMark>()
        : undefined;
    /** item_id → VAD start/end ms. Only when --log-svc. */
    const audioMetaByItem = logSvc
        ? new Map<string, { audio_start_ms?: number; audio_end_ms?: number }>()
        : undefined;
    const AUDIO_META_CAP = 32;

    const pruneAudioMetaIfNeeded = () => {
        if (!audioMetaByItem || !uplinkMarks) {
            return;
        }
        while (audioMetaByItem.size > AUDIO_META_CAP) {
            const oldest = audioMetaByItem.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            audioMetaByItem.delete(oldest);
            uplinkMarks.delete(oldest);
        }
    };

    const getAudioMeta = (itemId: string | undefined) =>
        itemId && audioMetaByItem ? audioMetaByItem.get(itemId) : undefined;

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
    /** Operator mute intent — reapplied after we rebuild the mic gate. */
    let micMutedIntent = false;
    let sessionDisposed = false;
    let recoverMicInFlight: Promise<void> | null = null;
    /** Unmute arrived while a background recover was still in flight — run again after. */
    let pendingGestureRecover = false;
    /** Skip recover on first paint; only run after we've actually been backgrounded. */
    let sawHidden = document.hidden;

    const micGateOptions = () => ({
        bypassGate: () => voiceWakeSleep?.state === "asleep",
        onGateChange: (gateOpen: boolean, level: number) => {
            opts.onMicLevel?.(level, gateOpen);
        },
        recordUplink: logSvc,
    });

    micGate = await createMicLevelGate(inputStream, micGateOptions());

    if (
        opts.onVoiceSpeedChange &&
        opts.onVoicePressAndHoldRequired
    ) {
        const baseFeedback = opts.onVoiceMoveFeedback;
        setVoiceMoveExecutionContext({
            mode: opts.voiceMoveExecutionMode ?? "direct",
            onSpeedChange: opts.onVoiceSpeedChange,
            onPressAndHoldRequired: opts.onVoicePressAndHoldRequired,
            onVoiceMoveFeedback: (feedback) => {
                if (
                    feedback.kind === "move_started" ||
                    feedback.kind === "macro_started"
                ) {
                    voiceWakeSleep?.notifyMotionOrCommand();
                }
                baseFeedback?.(feedback);
            },
        });
    } else {
        setVoiceMoveExecutionContext(undefined);
    }

    let audioSender: RTCRtpSender | undefined;
    for (const t of micGate.transmitStream.getAudioTracks()) {
        audioSender = pc.addTrack(t, micGate.transmitStream);
    }

    /**
     * Cold-start SVC posture while the Realtime peer stays up:
     * stop motion, asleep, muted.
     */
    const resetSvcToSafeDefaults = () => {
        executeStopMotionOnProvider(opts.voiceProvider);
        voiceWakeSleep?.sleep("disconnect");
        micMutedIntent = true;
        micGate?.setForceClosed(true);
        opts.onMicSafeReset?.();
    };

    /** Fresh getUserMedia → rebuild gate → replaceTrack on the OpenAI sender. */
    const reacquireMicStream = async (fromUserGesture: boolean) => {
        if (sessionDisposed) {
            return;
        }
        // Kick off getUserMedia before any await — iOS drops the Unmute gesture
        // if we await AudioContext.resume() first.
        const gumPromise = getUserMediaWithPrivilegeLog();
        if (!fromUserGesture) {
            resetSvcToSafeDefaults();
        }
        const nextStream = await gumPromise;
        if (sessionDisposed) {
            nextStream.getTracks().forEach((t) => {
                t.stop();
            });
            return;
        }

        inputStream.getTracks().forEach((t) => {
            t.stop();
        });
        micGate?.stop();
        inputStream = nextStream;
        bindInputStreamEnded(inputStream);
        // After swap — avoid a false Disconnected while the old track stops.
        syncMicCaptureFromInputStream();
        micGate = await createMicLevelGate(inputStream, micGateOptions());
        micGate.setForceClosed(micMutedIntent);

        const newTrack = micGate.transmitStream.getAudioTracks()[0] ?? null;
        if (!audioSender) {
            throw new Error("No RTCRtpSender for mic uplink");
        }
        await audioSender.replaceTrack(newTrack);

        if (!micGate.isHealthy()) {
            throw new Error("Mic still unhealthy after reacquire");
        }
        // Orange-dot / track.live can still mean silence — require a real callback.
        const active = await micGate.probeActivity();
        if (!active) {
            throw new Error("Mic reacquired but ScriptProcessor inactive");
        }
        opts.onLog?.("[Realtime] mic reacquired after foreground");
    };

    /**
     * Foreground / Unmute mic recovery.
     *
     * iOS standalone PWA: on background restore we only safe-reset + release
     * capture. getUserMedia waits for Unmute (tap gesture). Safari tabs and
     * other clients try resume + activity probe first, then reacquire if needed.
     */
    const recoverMicAfterForeground = (
        recoverOpts?: RecoverMicOptions,
    ): Promise<void> => {
        if (sessionDisposed) {
            return Promise.resolve();
        }
        const fromUserGesture = recoverOpts?.fromUserGesture === true;
        if (recoverMicInFlight) {
            // Don't drop an Unmute that raced a background recover — queue it.
            if (fromUserGesture) {
                pendingGestureRecover = true;
                return recoverMicInFlight.then(() => {
                    if (!pendingGestureRecover || sessionDisposed) {
                        return;
                    }
                    pendingGestureRecover = false;
                    return recoverMicAfterForeground({
                        fromUserGesture: true,
                    });
                });
            }
            return recoverMicInFlight;
        }

        const iosPwa = isIosStandalonePwa();
        recoverMicInFlight = (async () => {
            try {
                if (sessionDisposed) {
                    return;
                }

                // App Switcher / Control Center without a gesture: releasing is
                // safer than getUserMedia. iOS often returns a live track that
                // never delivers audio (Dynamic Island still shows the orange mic).
                if (iosPwa && !fromUserGesture) {
                    opts.onLog?.(
                        "[Realtime] iOS standalone PWA — release mic; unmute to reacquire",
                    );
                    resetSvcToSafeDefaults();
                    inputStream.getTracks().forEach((t) => {
                        t.stop();
                    });
                    micGate?.stop();
                    syncMicCaptureFromInputStream();
                    if (audioSender) {
                        await audioSender.replaceTrack(null);
                    }
                    return;
                }

                if (!fromUserGesture && micGate) {
                    const resumed = await micGate.resume();
                    if (sessionDisposed) {
                        return;
                    }
                    if (
                        resumed &&
                        micGate.isHealthy() &&
                        (await micGate.probeActivity())
                    ) {
                        opts.onLog?.(
                            "[Realtime] mic recovered via AudioContext.resume + activity probe",
                        );
                        return;
                    }
                }

                opts.onLog?.(
                    "[Realtime] reacquiring getUserMedia" +
                    (fromUserGesture ? " (user gesture)" : ""),
                );
                await reacquireMicStream(fromUserGesture);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                opts.onLog?.(`[Realtime] mic recovery failed: ${msg}`);
                resetSvcToSafeDefaults();
            }
        })().finally(() => {
            recoverMicInFlight = null;
        });
        return recoverMicInFlight;
    };

    const onVisibilityForMic = () => {
        if (document.hidden) {
            sawHidden = true;
            return;
        }
        // Ignore the visible state at session start.
        if (!sawHidden) {
            return;
        }
        sawHidden = false;
        void recoverMicAfterForeground();
    };
    const onPageShowForMic = (event: PageTransitionEvent) => {
        // bfcache restore, or coming back after we already saw hidden.
        if (event.persisted || sawHidden) {
            sawHidden = false;
            void recoverMicAfterForeground();
        }
    };
    document.addEventListener("visibilitychange", onVisibilityForMic);
    window.addEventListener("pageshow", onPageShowForMic);

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
            if (itemId !== "_default") {
                lastTranscriptItemId = itemId;
            }
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
        if (itemId !== "_default") {
            lastTranscriptItemId = itemId;
        }
        const completedItemId =
            itemId !== "_default" ? itemId : lastTranscriptItemId;
        const meta = logSvc ? getAudioMeta(completedItemId) : undefined;
        opts.onLog?.(
            `[Realtime] user transcript: ${transcript.slice(0, 160)}`,
            logSvc && completedItemId
                ? {
                      item_id: completedItemId,
                      audio_start_ms: meta?.audio_start_ms,
                      audio_end_ms: meta?.audio_end_ms,
                  }
                : undefined,
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
            voiceWakeSleep?.notifyMotionOrCommand();
        }

        opts.onLog?.(
            `[Realtime] Tool result ${JSON.stringify(result)} (${fc.call_id})`,
        );

        let parsedArgs: Record<string, unknown> = {};
        try {
            parsedArgs = JSON.parse(fc.arguments || "{}") as Record<string, unknown>;
        } catch {
            //
        }

        const toolItemId = logSvc
            ? lastTranscriptItemId || undefined
            : undefined;
        const toolMeta = getAudioMeta(toolItemId);
        emitVoiceInteraction({
            transcript: latestUserTranscriptForLog(),
            stt_model: "gpt-4o-transcribe",
            tool_name: fc.name,
            tool_args: parsedArgs,
            reasoning_model: "gpt-realtime-2.1",
            success: result.ok,
            detail: result.detail,
            listening_state: voiceWakeSleep?.state || "unknown",
            execution_mode: opts.voiceMoveExecutionMode || "button_provider",
            item_id: toolItemId,
            audio_start_ms: toolMeta?.audio_start_ms,
            audio_end_ms: toolMeta?.audio_end_ms,
        });

        if (dc.readyState === "open") {
            sendFnOutput(dc, fc.call_id, result);
        }
    };

    const handleVadSpeechEvents = (blob: Record<string, unknown>, eventType: string) => {
        if (!logSvc || !audioMetaByItem || !uplinkMarks) {
            return;
        }
        if (eventType === "input_audio_buffer.speech_started") {
            const itemId =
                typeof blob.item_id === "string" ? blob.item_id : "";
            if (!itemId) {
                return;
            }
            const audioStartMs =
                typeof blob.audio_start_ms === "number"
                    ? blob.audio_start_ms
                    : undefined;
            const prev = audioMetaByItem.get(itemId) ?? {};
            audioMetaByItem.set(itemId, {
                ...prev,
                ...(audioStartMs !== undefined
                    ? { audio_start_ms: audioStartMs }
                    : {}),
            });
            pruneAudioMetaIfNeeded();
            if (logSvc && micGate && !micGate.forceClosed) {
                const mark = micGate.markUplink(VOICE_CLIP_START_LOOKBACK_MS);
                if (mark) {
                    uplinkMarks.set(itemId, mark);
                }
            }
            return;
        }

        if (eventType !== "input_audio_buffer.speech_stopped") {
            return;
        }

        const itemId =
            typeof blob.item_id === "string" ? blob.item_id : "";
        if (!itemId) {
            return;
        }
        const audioEndMs =
            typeof blob.audio_end_ms === "number"
                ? blob.audio_end_ms
                : undefined;
        const prev = audioMetaByItem.get(itemId) ?? {};
        const meta = {
            ...prev,
            ...(audioEndMs !== undefined ? { audio_end_ms: audioEndMs } : {}),
        };
        audioMetaByItem.set(itemId, meta);

        if (!logSvc || !micGate || micGate.forceClosed) {
            uplinkMarks.delete(itemId);
            return;
        }

        const mark = uplinkMarks.get(itemId);
        uplinkMarks.delete(itemId);
        const floatSamples = mark
            ? micGate.copyUplinkSince(mark)
            : micGate.copyUplinkRecent(
                  Math.max(
                      VOICE_CLIP_START_LOOKBACK_MS,
                      meta.audio_end_ms !== undefined &&
                          meta.audio_start_ms !== undefined
                          ? meta.audio_end_ms -
                                meta.audio_start_ms +
                                VOICE_CLIP_START_LOOKBACK_MS
                          : 3000,
                  ),
              );

        if (
            floatSamples.length === 0 ||
            float32Rms(floatSamples) < VOICE_CLIP_SILENCE_RMS
        ) {
            return;
        }

        const pcm = downsampleFloat32ToInt16(
            floatSamples,
            micGate.sampleRate,
            VOICE_CLIP_SAMPLE_RATE,
        );
        if (pcm.length === 0) {
            return;
        }

        emitVoiceAudioClip({
            item_id: itemId,
            sampleRate: VOICE_CLIP_SAMPLE_RATE,
            pcm: pcm.buffer.slice(
                pcm.byteOffset,
                pcm.byteOffset + pcm.byteLength,
            ) as ArrayBuffer,
            audio_start_ms: meta.audio_start_ms,
            audio_end_ms: meta.audio_end_ms,
        });
    };

    const handleRealtimeDataMessage = async (blob: Record<string, unknown>) => {
        const eventType = String(blob.type ?? "");

        if (
            eventType === "input_audio_buffer.speech_started" ||
            eventType === "input_audio_buffer.speech_stopped"
        ) {
            if (logSvc) {
                handleVadSpeechEvents(blob, eventType);
            }
            return;
        }

        if (eventType.includes("input_audio_transcription")) {
            handleUserTranscription(blob, eventType);
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
                // Local stop for short transcripts matching VOICE_STOP_KEYWORDS — both
                // asleep and awake (safety). Otherwise wait for stop_motion or a
                // superseding movement tool.
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
        sessionDisposed = true;
        document.removeEventListener("visibilitychange", onVisibilityForMic);
        window.removeEventListener("pageshow", onPageShowForMic);
        voiceWakeSleep?.stop();
        voiceWakeSleep = undefined;
        micGate?.stop();
        inputStream.getTracks().forEach((t) => {
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
        sessionDisposed = true;
        document.removeEventListener("visibilitychange", onVisibilityForMic);
        window.removeEventListener("pageshow", onPageShowForMic);
        if (recoverMicInFlight) {
            await recoverMicInFlight.catch(() => undefined);
        }
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
        inputStream.getTracks().forEach((t) => {
            t.stop();
        });
        syncMicCaptureFromInputStream();
        pc.close();
        opts.onStatus?.("Disconnected");
    }

    return {
        disconnect,
        wake: () => voiceWakeSleep?.wake(),
        sleep: () => voiceWakeSleep?.sleep("phrase"),
        setMicMuted: (muted: boolean) => {
            micMutedIntent = muted;
            micGate?.setForceClosed(muted);
        },
        recoverMic: (recoverOpts) => recoverMicAfterForeground(recoverOpts),
    };
}
