/**
 * This is the voice command assistant component that
 * sits at the top of the screen. Very WIP.
 */

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
import { getOperatorVoiceSessionToken } from "shared/operatorVoiceSession";
import {
    isVoiceToolLogLine,
    VOICE_MIC_RMS_THRESHOLD,
    type VoiceSpeed,
    type VoiceMoveExecutionMode,
} from "../voice/constants";
import { voiceMoveFeedbackToToast, type VoiceMoveFeedback } from "../voice/voiceMoveFeedback";
import {
    AccessibleRadioGroup,
    type AccessibleRadioOption,
} from "./AccessibleRadioGroup";
import Ellipsis from "../basic_components/Ellipsis";
import type { AddToastFn } from "../layout_components/Toasts";
import "operator/css/VoiceCommandAssistant.css";

/** Explicit check to make sure operator is using
 * LAN/ngrok (LocalStorage + socket.io) and not cloud (Firebase) */
const isFirebaseStorage = process.env.storage === "firebase";

export type VoiceCommandAssistantProps = {
    onVelocityScaleApplied: (scale: number) => void;
    setActionMode: (mode: ActionModeType) => void;
    addToast: AddToastFn;
};

/** The use of `style` props will be moved to CSS when the VC feature becomes stable. */
const styleButton = {
    fontWeight: "bold" as const,
    width: "100%",
    height: 43,
    backgroundColor: "hsla(184, 100%, 50%, 1)",
    color: "hsl(0deg 0% 0% / 75%)",
};

const VOICE_MOVE_EXECUTION_OPTIONS: AccessibleRadioOption[] = [
    {
        value: "direct",
        label: "Direct",
        ariaLabel: "Direct",
    },
    {
        value: "button_provider",
        label: "Button Pad",
        ariaLabel: "Button Pad",
    },
];

/** OpenAI speech-to-speech voice POC overlay (Realtime WebRTC). */
export const VoiceCommandAssistant = ({
    onVelocityScaleApplied,
    setActionMode,
    addToast,
}: VoiceCommandAssistantProps) => {
    const sessionRef =
        useRef<ActiveRealtimeVoiceSession | null>(null);
    const [phase, phaseSet] = useState<
        "idle" | "connecting" | "live" | "error"
    >("idle");
    const [statusLine, statusLineSet] =
        useState<string>("Connect");
    const [micLevel, micLevelSet] = useState(0);
    const [micGateOpen, micGateOpenSet] = useState(false);
    const [voiceSessionReady, voiceSessionReadySet] = useState(() =>
        Boolean(getOperatorVoiceSessionToken()),
    );
    const [voiceMoveExecutionMode, voiceMoveExecutionModeSet] =
        useState<VoiceMoveExecutionMode>("direct");

    const executionModeLocked =
        phase === "connecting" || phase === "live";

    useEffect(() => {
        if (isFirebaseStorage) {
            return;
        }
        const id = window.setInterval(() => {
            voiceSessionReadySet(Boolean(getOperatorVoiceSessionToken()));
        }, 500);
        return () => window.clearInterval(id);
    }, []);

    const disconnect = useCallback(async () => {
        if (sessionRef.current) {
            await sessionRef.current.disconnect().catch(() => undefined);
            sessionRef.current = null;
        }
        phaseSet("idle");
        statusLineSet("Connect");
        micLevelSet(0);
        micGateOpenSet(false);
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
                addToast(toast.type, toast.message);
            }
        },
        [addToast],
    );

    const connect = useCallback(async () => {
        if (phase === "connecting" || phase === "live") {
            return;
        }
        try {
            phaseSet("connecting");
            statusLineSet("Connecting…");
            const s = await connectOpenAIRealtimeVoice({
                voiceProvider: buttonFunctionProvider,
                voiceMoveExecutionMode,
                onVoiceSpeedChange,
                onVoicePressAndHoldRequired,
                onVoiceMoveFeedback,
                onLog: (lg) => {
                    if (isVoiceToolLogLine(lg)) {
                        console.log(
                            "[VoiceCommandAssistant] tool trace:",
                            lg.slice(0, 240),
                        );
                    }
                },
                onMicLevel: (level, gateOpen) => {
                    micLevelSet(level);
                    micGateOpenSet(gateOpen);
                },
            });
            sessionRef.current = s;
            phaseSet("live");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[VoiceCommandAssistant] connect failed", e);
            setVoiceMoveExecutionContext(undefined);
            phaseSet("error");
            statusLineSet(`Error: ${msg}`);
            sessionRef.current = null;
        }
    }, [
        phase,
        voiceMoveExecutionMode,
        onVoiceSpeedChange,
        onVoicePressAndHoldRequired,
        onVoiceMoveFeedback
    ]);

    const robotOk = FunctionProvider.robotIsConnected();
    const voiceSessionOk = voiceSessionReady;
    const canConnectVoice =
        !isFirebaseStorage && robotOk && voiceSessionOk;

    const meterFill = Math.min(1, Math.max(0, micLevel));

    const micGateHint =
        phase !== "live"
            ? ""
            : micGateOpen
                ? "Listening..."
                : micLevel > 0.001
                    ? "Microphone gate closed"
                    : "Ready";

    const primaryButtonLabel =
        phase === "live"
            ? "Disconnect"
            : phase === "connecting"
                ? "Connecting…"
                : statusLine;
    const primaryButtonAriaLabel =
        phase === "connecting" ? "Connecting" : primaryButtonLabel;

    const onPrimaryButtonClick = () => {
        if (phase === "live") {
            void disconnect();
            return;
        }
        if (phase !== "connecting") {
            void connect();
        }
    };

    const primaryButtonDisabled =
        phase === "connecting" ||
        (phase !== "live" && !canConnectVoice);

    return (
        <div
            style={{
                zIndex: 10000,
                position: "absolute",
                bottom: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "hsla(0, 0%, 0%, 1)",
                backdropFilter: "blur(30px)",
                width: "100%",
                padding: "0px 20px 20px",
            }}
        >
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    fontWeight: 600,
                    width: "100%",
                    maxWidth: 520,
                }}
            >
                <div
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        gap: "20px",
                        margin: "10px 0 0",
                        width: "100%",
                    }}
                >
                    <button
                        className="voice-command-assistant__primary-button"
                        style={styleButton}
                        type="button"
                        disabled={primaryButtonDisabled}
                        aria-label={primaryButtonAriaLabel}
                        aria-busy={phase === "connecting"}
                        onClick={onPrimaryButtonClick}
                    >
                        {phase === "connecting" ? (
                            <>
                                <span
                                    className="voice-command-assistant__spinner"
                                    aria-hidden
                                />
                                <span className="voice-command-assistant__connecting-label">
                                    Connecting
                                    <span
                                        className="voice-command-assistant__connecting-ellipsis"
                                        aria-hidden="true"
                                    >
                                        <Ellipsis
                                            size={2}
                                            gap={1}
                                            color="hsl(0deg 0% 0% / 75%)"
                                        />
                                    </span>
                                </span>
                            </>
                        ) : (
                            primaryButtonLabel
                        )}
                    </button>
                </div>
                {robotOk && voiceSessionOk && phase !== "live" ? (
                    <AccessibleRadioGroup
                        className="voice-move-execution-mode"
                        legend="Movement Execution Mode"
                        name="voiceMoveExecutionMode"
                        options={VOICE_MOVE_EXECUTION_OPTIONS}
                        value={voiceMoveExecutionMode}
                        onChange={(value) =>
                            voiceMoveExecutionModeSet(
                                value as VoiceMoveExecutionMode,
                            )
                        }
                        disabled={executionModeLocked}
                        padding={8}
                        hasRipple
                        layout="horizontal"
                    />
                ) : null}
                {phase === "live" ? (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "center",
                            alignItems: "center",
                            gap: "6px",
                            width: "100%",
                            height: 78,
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                width: "100%",
                            }}
                        >
                            <span
                                style={{
                                    fontSize: "0.82em",
                                    color: "hsl(184deg 60% 87%)",
                                    minWidth: "2.5em",
                                }}
                            >
                                Mic
                            </span>
                            <div
                                role="meter"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(micLevel * 100)}
                                aria-label="Microphone input level"
                                style={{
                                    flex: 1,
                                    height: "8px",
                                    borderRadius: "4px",
                                    backgroundColor: "hsla(0, 0%, 100%, 0.15)",
                                    overflow: "hidden",
                                    position: "relative",
                                }}
                            >
                                <div
                                    style={{
                                        height: "100%",
                                        width: "100%",
                                        transformOrigin: "left center",
                                        transform: `scaleX(${meterFill})`,
                                        backgroundColor: micGateOpen
                                            ? "hsl(184deg 100% 50%)"
                                            : "hsla(184, 100%, 50%, 0.45)",
                                        transition: "transform 0.05s linear",
                                        willChange: "transform",
                                    }}
                                />
                                <div
                                    style={{
                                        position: "absolute",
                                        left: `${Math.round(VOICE_MIC_RMS_THRESHOLD * 100)}%`,
                                        top: 0,
                                        bottom: 0,
                                        width: "2px",
                                        backgroundColor:
                                            "hsla(0, 0%, 100%, 0.55)",
                                    }}
                                    title="Volume gate threshold"
                                />
                            </div>
                        </div>
                        <p
                            style={{
                                fontWeight: 400,
                                fontSize: "0.82em",
                                margin: 0,
                                color: micGateOpen
                                    ? "hsl(184deg 100% 50%)"
                                    : "hsl(184deg 60% 87%)",
                            }}
                        >
                            {micGateHint}
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export default VoiceCommandAssistant;
