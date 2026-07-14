/**
 * Asleep/awake listening mode for voice control.
 * Wake/sleep phrases are detected from OpenAI Realtime user transcripts.
 * Movement tools are blocked while asleep; mic uplink bypasses volume gate while asleep.
 */

import type { FunctionProvider } from "../function_providers/FunctionProvider";
import {
    matchesSleepPhrase,
    matchesWakePhrase,
    VOICE_AUTO_SLEEP_IDLE_MS,
    VOICE_AUTO_SLEEP_POLL_MS,
    VOICE_PHRASE_DEBOUNCE_MS,
    VOICE_PHRASE_WAKE_SLEEP_IGNORE_MS,
    VOICE_PHRASE_WAKE_TOOL_IGNORE_MS,
} from "./constants";
import { normalizePhrase } from "./phraseUtils";

export type VoiceListeningState = "asleep" | "awake";

export type VoiceSleepReason = "phrase" | "idle" | "disconnect";

export type VoiceWakeSleep = {
    readonly state: VoiceListeningState;
    wake(): void;
    sleep(reason: VoiceSleepReason): void;
    notifyMotionOrCommand(): void;
    tryPhraseFromTranscript(transcript: string, final?: boolean): void;
    shouldIgnoreErroneousToolAfterPhraseWake(): boolean;
    start(): void;
    stop(): void;
};

export type CreateVoiceWakeSleepOptions = {
    provider: FunctionProvider;
    onStateChange?: (state: VoiceListeningState) => void;
    onLog?: (message: string) => void;
};

const MAX_TRANSCRIPT_FRAGMENTS = 8;

export function createVoiceWakeSleep(
    opts: CreateVoiceWakeSleepOptions,
): VoiceWakeSleep {
    let state: VoiceListeningState = "asleep";
    let lastMotionAt = Date.now();
    let lastWakePhraseAt = 0;
    let lastSleepPhraseAt = 0;
    let phraseWakeAt = 0;
    let idlePollTimer: ReturnType<typeof setInterval> | undefined;
    const recentFragments: string[] = [];

    const log = (message: string) => {
        opts.onLog?.(`[WakeSleep] ${message}`);
    };

    const notifyState = () => {
        opts.onStateChange?.(state);
    };

    const clearFragments = () => {
        recentFragments.length = 0;
    };

    const pushFragment = (normalized: string) => {
        recentFragments.push(normalized);
        while (recentFragments.length > MAX_TRANSCRIPT_FRAGMENTS) {
            recentFragments.shift();
        }
    };

    const inPhraseWakeCooldown = (now: number) =>
        phraseWakeAt > 0 &&
        now - phraseWakeAt < VOICE_PHRASE_WAKE_SLEEP_IGNORE_MS;

    const wake = (fromPhrase = false) => {
        if (state === "awake") {
            notifyMotionOrCommand();
            return;
        }
        state = "awake";
        clearFragments();
        notifyMotionOrCommand();
        if (fromPhrase) {
            phraseWakeAt = Date.now();
        }
        log("awake");
        notifyState();
    };

    const sleep = (reason: VoiceSleepReason) => {
        if (state === "asleep" && reason !== "disconnect") {
            return;
        }
        state = "asleep";
        phraseWakeAt = 0;
        clearFragments();
        log(`asleep (${reason})`);
        notifyState();
    };

    const notifyMotionOrCommand = () => {
        lastMotionAt = Date.now();
    };

    const tryWakePhrase = (normalized: string, now: number): boolean => {
        if (
            state !== "asleep" ||
            !matchesWakePhrase(normalized) ||
            now - lastWakePhraseAt < VOICE_PHRASE_DEBOUNCE_MS
        ) {
            return false;
        }
        lastWakePhraseAt = now;
        log(`wake phrase in transcript: "${normalized}"`);
        wake(true);
        return true;
    };

    const trySleepPhrase = (normalized: string, now: number): boolean => {
        if (
            state !== "awake" ||
            inPhraseWakeCooldown(now) ||
            !matchesSleepPhrase(normalized) ||
            now - lastSleepPhraseAt < VOICE_PHRASE_DEBOUNCE_MS
        ) {
            return false;
        }
        lastSleepPhraseAt = now;
        log(`sleep phrase in transcript: "${normalized}"`);
        sleep("phrase");
        return true;
    };

    const tryPhraseFromTranscript = (transcript: string, final = false) => {
        const normalized = normalizePhrase(transcript);
        if (!normalized) {
            return;
        }
        const now = Date.now();

        if (state === "asleep") {
            if (tryWakePhrase(normalized, now)) {
                return;
            }
            pushFragment(normalized);
            if (recentFragments.length > 1) {
                tryWakePhrase(recentFragments.join(" "), now);
            }
            return;
        }

        if (!final || inPhraseWakeCooldown(now)) {
            return;
        }
        trySleepPhrase(normalized, now);
    };

    const shouldIgnoreErroneousToolAfterPhraseWake = () =>
        phraseWakeAt > 0 &&
        Date.now() - phraseWakeAt < VOICE_PHRASE_WAKE_TOOL_IGNORE_MS;

    const tickIdle = () => {
        if (state !== "awake") {
            return;
        }
        if (opts.provider.isMotionActive()) {
            lastMotionAt = Date.now();
            return;
        }
        if (Date.now() - lastMotionAt >= VOICE_AUTO_SLEEP_IDLE_MS) {
            sleep("idle");
        }
    };

    const start = () => {
        idlePollTimer = setInterval(tickIdle, VOICE_AUTO_SLEEP_POLL_MS);
        sleep("disconnect");
    };

    const stop = () => {
        if (idlePollTimer !== undefined) {
            clearInterval(idlePollTimer);
            idlePollTimer = undefined;
        }
        sleep("disconnect");
    };

    return {
        get state() {
            return state;
        },
        wake: () => wake(false),
        sleep,
        notifyMotionOrCommand,
        tryPhraseFromTranscript,
        shouldIgnoreErroneousToolAfterPhraseWake,
        start,
        stop,
    };
}