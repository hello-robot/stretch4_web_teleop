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

/** Explicit check to make sure operator is using
 * LAN/ngrok (LocalStorage + socket.io) and not cloud (Firebase) */
const isFirebaseStorage = process.env.storage === "firebase";

export type VoiceCommandAssistantProps = {
    onVelocityScaleApplied: (scale: number) => void;
    setActionMode: (mode: ActionModeType) => void;
};

/** The use of `style` props will be moved to CSS when the VC feature becomes stable. */
const styleButton = {
    fontWeight: "bold" as const,
    width: "100%",
    backgroundColor: "hsla(184, 100%, 50%, 1)",
    padding: "17px 0",
    color: "hsl(0deg 0% 0% / 75%)",
};

/** OpenAI speech-to-speech voice POC overlay (Realtime WebRTC). */
export const VoiceCommandAssistant = ({
    onVelocityScaleApplied,
    setActionMode,
}: VoiceCommandAssistantProps) => {
    const sessionRef =
        useRef<ActiveRealtimeVoiceSession | null>(null);
    const [phase, phaseSet] = useState<
        "idle" | "connecting" | "live" | "error"
    >("idle");
    const [statusLine, statusLineSet] =
        useState<string>("Not connected");
    const [lastExec, lastExecSet] =
        useState<string>("Awaiting execute_base_move tool…");
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
        statusLineSet("Not connected");
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
                onStatus: (t) =>
                    statusLineSet((prev) =>
                        `${t} (${new Date().toLocaleTimeString()})`,
                    ),
                onLog: (lg) => {
                    if (isVoiceToolLogLine(lg)) {
                        lastExecSet(lg.slice(0, 240));
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
                ? "Listening — speak clearly at the device"
                : micLevel > 0.001
                    ? "Microphone gate closed — speak louder or closer"
                    : "Waiting for voice — speak at the device";

    return (
        <div
            style={{
                zIndex: 10000,
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                top: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "hsla(0, 0%, 0%, 0.5)",
                backdropFilter: "blur(30px)",
                width: "100%",
                height: "fit-content",
                padding: "20px 20px 12px",
                transform: phase === "live" ? "translateY(-128px)" : "translateY(0%)",
                transition: "transform 0.3s ease-in-out",
            }}
        >
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    fontWeight: 600,
                    width: "100%",
                    maxWidth: 520,
                }}
            >
                {robotOk && voiceSessionOk ? (
                    <fieldset
                        disabled={executionModeLocked}
                        style={{
                            padding: '20px 15px',
                            width: "100%",
                            background: 'hsl(184deg 100% 40% / 10%)',
                            borderRadius: 10,
                            border: '1px solid hsl(184deg 100% 40% / 10%)',
                        }}
                    >
                        <legend
                            style={{
                                position: 'absolute',
                                top: 29,
                                fontSize: "0.88em",
                                color: "hsl(184deg 60% 87%)",
                                marginBottom: "6px",
                                opacity: 0.7,
                            }}
                        >
                            Move execution (locked while voice connected)
                        </legend>
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "8px",
                                margin: '15px 0 0',
                                fontSize: "0.88em",
                                color: "hsl(184deg 60% 87%)",
                            }}
                        >
                            <label
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    cursor: executionModeLocked
                                        ? "not-allowed"
                                        : "pointer",
                                }}
                            >
                                <input
                                    type="radio"
                                    name="voiceMoveExecutionMode"
                                    checked={
                                        voiceMoveExecutionMode === "direct"
                                    }
                                    disabled={executionModeLocked}
                                    onChange={() =>
                                        voiceMoveExecutionModeSet("direct")
                                    }
                                />
                                Direct base calls
                            </label>
                            <label
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    cursor: executionModeLocked
                                        ? "not-allowed"
                                        : "pointer",
                                }}
                            >
                                <input
                                    type="radio"
                                    name="voiceMoveExecutionMode"
                                    checked={
                                        voiceMoveExecutionMode ===
                                        "button_provider"
                                    }
                                    disabled={executionModeLocked}
                                    onChange={() =>
                                        voiceMoveExecutionModeSet(
                                            "button_provider",
                                        )
                                    }
                                />
                                Press movement buttons
                            </label>
                        </div>
                    </fieldset>
                ) : null}
                <p
                    style={{
                        fontWeight: 600,
                        wordBreak: "break-word",
                        margin: '10px 0 0',
                        color: "hsl(184deg 100% 50%)",
                    }}
                >
                    {statusLine}
                </p>
                {phase === "live" ? (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                            width: "100%",
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
                <div
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        gap: "20px",
                        margin: "10px 0 0",
                        width: "100%",
                    }}
                >
                    {phase !== "live"
                        // Connect microphone
                        ? (<button
                            style={styleButton}
                            type="button"
                            disabled={
                                phase === "connecting" ||
                                !canConnectVoice
                            }
                            onClick={() => void connect()}
                        >
                            Connect voice
                        </button>)
                        // Disconnect microphone
                        : (<button
                            style={styleButton}
                            type="button"
                            disabled={phase !== "live" && phase !== "connecting"}
                            onClick={() => void disconnect()}
                        >
                            Disconnect
                        </button>)
                    }
                </div>
                <p
                    aria-live="polite"
                    style={{ fontWeight: 400, fontSize: "0.88em", margin: 0, color: "hsl(184deg 60% 87%)" }}
                >
                    Tool trace: {lastExec}
                </p>
            </div>
        </div>
    );
};

export default VoiceCommandAssistant;
