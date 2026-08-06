/** Headless auto-connect lifecycle for the OpenAI Realtime voice session. */

import React, {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { buttonFunctionProvider } from "..";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import { ActionModeType } from "../utils/component_definitions";
import { velocityScaleForVoiceSpeed } from "../utils/action-speed-scale";
import {
    connectOpenAIRealtimeVoice,
    type ActiveRealtimeVoiceSession,
} from "../voice/realtimeSession";
import { setVoiceMoveExecutionContext } from "../voice/executeBaseMove";
import {
    getVoiceStatusSnapshot,
    setVoiceStatus,
    subscribeVoiceStatus,
} from "../voice/voiceStatusStore";
import { getOperatorVoiceSessionToken } from "shared/operatorVoiceSession";
import {
    isVoiceToolLogLine,
    VOICE_AUTO_MUTE_ENABLED,
    VOICE_AUTO_MUTE_IDLE_MS,
    VOICE_AUTO_SLEEP_POLL_MS,
    type ControlAutoNavAction,
    type ControlAutoNavResult,
    type LoadAutoNavLocationResult,
    type SavedLocationsModalAction,
    type SetSavedLocationsModalResult,
    type VoiceSceneName,
    type VoiceSpeed,
    type VoiceMoveExecutionMode,
} from "../voice/constants";
import {
    bumpVoiceCommandActivity,
    getLastVoiceCommandActivityAt,
} from "../voice/voiceCommandActivity";
import { voiceMoveFeedbackToToast, type VoiceMoveFeedback } from "../voice/voiceMoveFeedback";
import type { SaveMapLocationResult } from "../voice/executeSaveMapLocation";
import type { AddToastFn } from "../layout_components/Toasts";

const SCENE_TOAST_LABELS: Record<VoiceSceneName, string> = {
    pilot: "Switching to Pilot",
    autonav: "Switching to AutoNav",
};

/** Explicit check to make sure operator is using
 * LAN/ngrok (LocalStorage + socket.io) and not cloud (Firebase) */
const isFirebaseStorage = process.env.storage === "firebase";

/** Product default; "direct" remains available for future user preferences. */
const VOICE_MOVE_EXECUTION_MODE: VoiceMoveExecutionMode = "button_provider";

/** Cooldown before auto-retry after a failed connect (no manual retry UI). */
const CONNECT_RETRY_MS = 3000;

const clearVoiceUiStatus = () =>
    setVoiceStatus({
        connected: false,
        micGateOpen: false,
        listeningState: "asleep",
    });

export type VoiceCommandAssistantProps = {
    onVelocityScaleApplied: (scale: number) => void;
    setActionMode: (mode: ActionModeType) => void;
    addToast: AddToastFn;
    onSwitchScene: (scene: VoiceSceneName) => void;
    onSetSavedLocationsModal: (
        action: SavedLocationsModalAction,
    ) => SetSavedLocationsModalResult;
    onControlAutoNav: (action: ControlAutoNavAction) => ControlAutoNavResult;
    onCancelAutoNavOnStop: () => ControlAutoNavResult;
    onGetAutoNavSavedPoseNames: () => string[] | null;
    onLoadAutoNavLocation: (poseName: string) => LoadAutoNavLocationResult;
};

/** OpenAI speech-to-speech voice session controller (Realtime WebRTC). */
export const VoiceCommandAssistant = ({
    onVelocityScaleApplied,
    setActionMode,
    addToast,
    onSwitchScene,
    onSetSavedLocationsModal,
    onControlAutoNav,
    onCancelAutoNavOnStop,
    onGetAutoNavSavedPoseNames,
    onLoadAutoNavLocation,
}: VoiceCommandAssistantProps) => {
    const sessionRef =
        useRef<ActiveRealtimeVoiceSession | null>(null);
    const connectInFlightRef = useRef(false);
    const retryTimeoutRef = useRef<number | null>(null);
    const [phase, phaseSet] = useState<
        "idle" | "connecting" | "live" | "error"
    >("idle");
    const [voiceSessionReady, voiceSessionReadySet] = useState(() =>
        Boolean(getOperatorVoiceSessionToken()),
    );
    const [robotOk, robotOkSet] = useState(() =>
        FunctionProvider.robotIsConnected(),
    );

    useEffect(() => {
        if (isFirebaseStorage) {
            return;
        }
        const id = window.setInterval(() => {
            voiceSessionReadySet(Boolean(getOperatorVoiceSessionToken()));
            robotOkSet(FunctionProvider.robotIsConnected());
        }, 500);
        return () => window.clearInterval(id);
    }, []);

    const disconnect = useCallback(async () => {
        if (retryTimeoutRef.current !== null) {
            window.clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }
        if (sessionRef.current) {
            await sessionRef.current.disconnect().catch(() => undefined);
            sessionRef.current = null;
        }
        phaseSet("idle");
        clearVoiceUiStatus();
    }, []);

    useEffect(() => {
        return () => {
            void disconnect();
        };
    }, [disconnect]);

    const onVoiceSpeedChange = useCallback(
        (speed: VoiceSpeed) =>
            onVelocityScaleApplied(velocityScaleForVoiceSpeed(speed)),
        [onVelocityScaleApplied],
    );

    const onVoicePressAndHoldRequired = useCallback(
        () => setActionMode(ActionModeType.PressAndHold),
        [setActionMode],
    );

    const onVoiceMoveFeedback = useCallback(
        (feedback: VoiceMoveFeedback) => {
            const toast = voiceMoveFeedbackToToast(feedback);
            if (toast) {
                addToast(toast.type, toast.message, undefined, "voice");
            }
        },
        [addToast],
    );

    const handleSwitchScene = useCallback(
        (scene: VoiceSceneName) => {
            onSwitchScene(scene);
            addToast("info", SCENE_TOAST_LABELS[scene], undefined, "voice");
        },
        [onSwitchScene, addToast],
    );

    const handleSaveMapLocationResult = useCallback(
        (result: SaveMapLocationResult) => {
            if (result.ok) {
                const label = result.label ?? "";
                addToast(
                    "info",
                    `Location "${label}" added.`,
                    undefined,
                    "voice",
                );
                return;
            }
            addToast("error", result.detail, undefined, "voice");
        },
        [addToast],
    );

    const handleSetSavedLocationsModal = useCallback(
        (action: SavedLocationsModalAction): SetSavedLocationsModalResult => {
            const result = onSetSavedLocationsModal(action);
            if (!result.ok) {
                addToast("error", result.detail, undefined, "voice");
            }
            return result;
        },
        [onSetSavedLocationsModal, addToast],
    );

    const handleControlAutoNav = useCallback(
        (action: ControlAutoNavAction): ControlAutoNavResult => {
            const result = onControlAutoNav(action);
            if (!result.ok) {
                addToast("error", result.detail, undefined, "voice");
            } else {
                addToast(
                    "info",
                    action === "start"
                        ? "Starting AutoNav"
                        : "Cancelling AutoNav",
                    undefined,
                    "voice",
                );
            }
            return result;
        },
        [onControlAutoNav, addToast],
    );

    /** Bare stop: cancel AutoNav only when navigating; never toast failures. */
    const handleCancelAutoNavOnStop = useCallback((): ControlAutoNavResult => {
        const result = onCancelAutoNavOnStop();
        if (result.ok) {
            addToast("info", "Cancelling AutoNav", undefined, "voice");
        }
        return result;
    }, [onCancelAutoNavOnStop, addToast]);

    const handleLoadAutoNavLocation = useCallback(
        (poseName: string): LoadAutoNavLocationResult => {
            const result = onLoadAutoNavLocation(poseName);
            // Success only — unknown/ambiguous/prefix failures stay silent.
            if (result.ok) {
                const label = result.label ?? poseName;
                addToast(
                    "info",
                    `Selected "${label}"`,
                    undefined,
                    "voice",
                );
            }
            return result;
        },
        [onLoadAutoNavLocation, addToast],
    );

    const connect = useCallback(async () => {
        if (phase === "connecting" || phase === "live") {
            return;
        }
        try {
            phaseSet("connecting");
            const s = await connectOpenAIRealtimeVoice({
                voiceProvider: buttonFunctionProvider,
                voiceMoveExecutionMode: VOICE_MOVE_EXECUTION_MODE,
                onVoiceSpeedChange,
                onVoicePressAndHoldRequired,
                onVoiceMoveFeedback,
                onSwitchScene: handleSwitchScene,
                onSaveMapLocationResult: handleSaveMapLocationResult,
                onSetSavedLocationsModal: handleSetSavedLocationsModal,
                onControlAutoNav: handleControlAutoNav,
                onCancelAutoNavOnStop: handleCancelAutoNavOnStop,
                onGetAutoNavSavedPoseNames,
                onLoadAutoNavLocation: handleLoadAutoNavLocation,
                onListeningState: (listeningState) => {
                    setVoiceStatus({ listeningState });
                },
                onLog: (lg) => {
                    if (
                        lg.includes("[WakeSleep]") ||
                        lg.includes("user transcript") ||
                        isVoiceToolLogLine(lg)
                    ) {
                        console.log("[VoiceCommandAssistant]", lg.slice(0, 240));
                    }
                },
                onMicLevel: (_level, gateOpen) => {
                    setVoiceStatus({ micGateOpen: gateOpen });
                },
            });
            sessionRef.current = s;
            s.setMicMuted(getVoiceStatusSnapshot().micMuted);
            phaseSet("live");
            setVoiceStatus({ connected: true });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[VoiceCommandAssistant] connect failed", e);
            setVoiceMoveExecutionContext(undefined);
            phaseSet("error");
            sessionRef.current = null;
            clearVoiceUiStatus();
            if (retryTimeoutRef.current !== null) {
                window.clearTimeout(retryTimeoutRef.current);
            }
            retryTimeoutRef.current = window.setTimeout(() => {
                retryTimeoutRef.current = null;
                phaseSet((current) =>
                    current === "error" ? "idle" : current,
                );
            }, CONNECT_RETRY_MS);
        }
    }, [
        phase,
        onVoiceSpeedChange,
        onVoicePressAndHoldRequired,
        onVoiceMoveFeedback,
        handleSwitchScene,
        handleSaveMapLocationResult,
        handleSetSavedLocationsModal,
        handleControlAutoNav,
        handleCancelAutoNavOnStop,
        onGetAutoNavSavedPoseNames,
        handleLoadAutoNavLocation,
    ]);

    const canConnectVoice =
        !isFirebaseStorage && robotOk && voiceSessionReady;

    useEffect(() => {
        if (
            !canConnectVoice ||
            phase !== "idle" ||
            connectInFlightRef.current
        ) {
            return;
        }
        connectInFlightRef.current = true;
        void connect().finally(() => {
            connectInFlightRef.current = false;
        });
    }, [canConnectVoice, phase, connect]);

    useEffect(() => {
        return subscribeVoiceStatus(() => {
            sessionRef.current?.setMicMuted(
                getVoiceStatusSnapshot().micMuted,
            );
        });
    }, []);

    useEffect(() => {
        let wasMuted = getVoiceStatusSnapshot().micMuted;
        const onStatus = () => {
            const { micMuted } = getVoiceStatusSnapshot();
            if (wasMuted && !micMuted) {
                bumpVoiceCommandActivity();
            }
            wasMuted = micMuted;
        };
        const unsub = subscribeVoiceStatus(onStatus);
        onStatus();
        return unsub;
    }, []);

    useEffect(() => {
        if (!VOICE_AUTO_MUTE_ENABLED || phase !== "live") {
            return;
        }
        const id = window.setInterval(() => {
            const { connected, micMuted } = getVoiceStatusSnapshot();
            if (!connected || micMuted) {
                return;
            }
            const lastAt = getLastVoiceCommandActivityAt();
            if (
                lastAt > 0 &&
                Date.now() - lastAt >= VOICE_AUTO_MUTE_IDLE_MS
            ) {
                setVoiceStatus({ micMuted: true });
            }
        }, VOICE_AUTO_SLEEP_POLL_MS);
        return () => window.clearInterval(id);
    }, [phase]);

    return null;
};

export default VoiceCommandAssistant;
