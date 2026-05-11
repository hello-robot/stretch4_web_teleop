import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import '../../css/ButtonCancelPlayback.css';

interface ButtonCancelPlaybackProps {
    isRecordingPlaying: boolean;
    handlePlaybackCancel: () => void;
}

/**
 * Floating "Stop" button that appears during movement recording playback.
 * Fades in/out with a framer-motion animation and is centered at the
 * bottom of its parent container.
 */
export const ButtonCancelPlayback = (props: ButtonCancelPlaybackProps) => {
    return (
        <AnimatePresence>
            {props.isRecordingPlaying && (
                <motion.div
                    className="cancel-playback-container"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <button
                        className="cancel-playback-btn"
                        onPointerDown={props.handlePlaybackCancel}
                    >
                        <span className="cancel-playback-icon">
                            <span className="cancel-playback-icon-inner">
                                <span className="cancel-playback-icon-square" />
                            </span>
                        </span>
                        Stop
                    </button>
                </motion.div>
            )
            }
        </AnimatePresence >
    );
};
