import React from "react";
import { motion } from "framer-motion";

/** Matches original waveform SVG bar geometry (viewBox 0 0 14 14). */
const BAR_WIDTH = 2.78572;
const BAR_RX = BAR_WIDTH / 2;
const BAR_CENTERS = [1.89286, 7, 12.10714] as const;
/** Idle: near-circles; center slightly taller. */
const IDLE_HEIGHTS = [2.9, 3.6, 2.9] as const;
/** Active geometry (fixed); visual height via composited scaleY. */
const ACTIVE_HEIGHTS = [9.28572, 13, 9.28572] as const;

const IDLE_SCALE_Y: readonly [number, number, number] = [
    IDLE_HEIGHTS[0] / ACTIVE_HEIGHTS[0],
    IDLE_HEIGHTS[1] / ACTIVE_HEIGHTS[1],
    IDLE_HEIGHTS[2] / ACTIVE_HEIGHTS[2],
];

type VoicePilotMicIconProps = {
    /** When true, bars pulse (mic gate open). */
    active: boolean;
};

/** Animated 3-bar waveform icon for the voice-pilot footer label. */
const VoicePilotMicIcon = ({ active }: VoicePilotMicIconProps) => (
    <svg
        className="voice-pilot-mic-icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
    >
        {BAR_CENTERS.map((cx, index) => {
            const activeH = ACTIVE_HEIGHTS[index];
            const idleScale = IDLE_SCALE_Y[index];
            const y = (14 - activeH) / 2;
            return (
                <motion.rect
                    key={cx}
                    className="voice-pilot-mic-bar"
                    x={cx - BAR_WIDTH / 2}
                    y={y}
                    width={BAR_WIDTH}
                    height={activeH}
                    rx={BAR_RX}
                    ry={BAR_RX}
                    fill="#54BBFF"
                    initial={false}
                    animate={
                        active
                            ? {
                                  scaleY: [0.82, 1, 0.7, 1],
                              }
                            : {
                                  scaleY: idleScale,
                              }
                    }
                    transition={
                        active
                            ? {
                                  duration: 0.5,
                                  repeat: Infinity,
                                  ease: "easeInOut",
                                  delay: index * 0.1,
                              }
                            : {
                                  type: "spring",
                                  stiffness: 420,
                                  damping: 32,
                              }
                    }
                />
            );
        })}
    </svg>
);

export default VoicePilotMicIcon;
