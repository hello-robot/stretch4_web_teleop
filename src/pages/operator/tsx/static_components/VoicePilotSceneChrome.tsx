import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import VoicePilotMicIcon from "./VoicePilotMicIcon";
import { useVoiceStatus } from "../voice/voiceStatusStore";

type VoicePilotSceneChromeProps = {
    sceneSelected: string;
    fallbackName: string | undefined;
};

/**
 * Pilot scene-button label + fancy-border mic glow.
 * Owns voice chrome so FooterGlobal stays layout-only.
 */
const VoicePilotSceneChrome: React.FC<VoicePilotSceneChromeProps> = ({
    sceneSelected,
    fallbackName,
}) => {
    const { connected, micGateOpen, listeningState } = useVoiceStatus();
    const showVoicePilot =
        sceneSelected === "pilot-mode" && connected;
    const showWaveform = showVoicePilot && listeningState === "awake";
    const showMicGateGlow = showWaveform && micGateOpen;

    return (
        <>
            <span className="scene-menu-button__label">
                {showVoicePilot ? (
                    <>
                        <AnimatePresence initial={false} mode="popLayout">
                            {showWaveform ? (
                                <motion.span
                                    key="voice-pilot-mic"
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
                            Voice Pilot
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
