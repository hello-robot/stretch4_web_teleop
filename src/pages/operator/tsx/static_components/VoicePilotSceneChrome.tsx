import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import VoicePilotMicIcon from "./VoicePilotMicIcon";
import { useVoiceStatus } from "../voice/voiceStatusStore";

type VoicePilotSceneChromeProps = {
    sceneSelected: string;
    fallbackName: string | undefined;
};

/** Scene ids that show "Voice …" chrome while the Realtime session is connected. */
const VOICE_SCENE_LABELS: Record<string, string> = {
    "pilot-mode": "Voice Pilot",
    autonav: "Voice AutoNav",
};

/**
 * Scene-button label + fancy-border mic glow for voice-enabled scenes.
 * "Voice …" label only while unmuted; waveform also needs awake;
 * border glow pulses on RMS gate (even asleep).
 * Owns voice chrome so FooterGlobal stays layout-only.
 */
const VoicePilotSceneChrome: React.FC<VoicePilotSceneChromeProps> = ({
    sceneSelected,
    fallbackName,
}) => {
    const { connected, micGateOpen, micMuted, listeningState } =
        useVoiceStatus();
    const voiceLabel = VOICE_SCENE_LABELS[sceneSelected];
    const showVoiceChrome =
        Boolean(voiceLabel) && connected && !micMuted;
    const showWaveform =
        showVoiceChrome && listeningState === "awake";
    const showMicGateGlow = showVoiceChrome && micGateOpen;

    return (
        <>
            <span className="scene-menu-button__label">
                {showVoiceChrome ? (
                    <>
                        <AnimatePresence initial={false} mode="popLayout">
                            {showWaveform ? (
                                <motion.span
                                    key="voice-scene-mic"
                                    className="voice-pilot-mic-icon-wrap"
                                    initial={{ opacity: 0, scaleX: 0 }}
                                    animate={{ opacity: 1, scaleX: 1 }}
                                    exit={{ opacity: 0, scaleX: 0 }}
                                    transition={{
                                        duration: 0.2,
                                        ease: "easeOut",
                                    }}
                                >
                                    <VoicePilotMicIcon active={micGateOpen} />
                                </motion.span>
                            ) : null}
                        </AnimatePresence>
                        <motion.span
                            layout
                            transition={{
                                duration: 0.2,
                                ease: "easeOut",
                            }}
                        >
                            {voiceLabel}
                        </motion.span>
                    </>
                ) : (
                    fallbackName
                )}
            </span>
            <div
                className={
                    showMicGateGlow
                        ? "fancy-border fancy-border--mic-active"
                        : "fancy-border"
                }
            />
        </>
    );
};

export default VoicePilotSceneChrome;
