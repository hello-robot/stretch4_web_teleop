import StopCircleIcon from '@mui/icons-material/StopCircle';
import { AnimatePresence, motion } from 'framer-motion';
import MagneticWrapper from '../static_components/MagneticWrapper';
import StartNavIcon from '../../icons/StartNavIcon.svg';

export type FooterCenterMode = 'start' | 'stop' | 'pose';

/** Shared fade between Start / Stop and Cancel / Localize. */
const footerCenterTransition = {
    opacity: { duration: 0.2, ease: 'easeOut' as const },
    scale: { type: 'spring' as const, stiffness: 420, damping: 34 },
};

const footerCenterMotion = {
    initial: { opacity: 0, scale: 0.92 },
    animate: { opacity: 1, scale: 1 },
    // pointerEvents applies at the start of the exit, so the fading control cannot be tapped.
    exit: { opacity: 0, scale: 0.92, pointerEvents: 'none' as const },
};

const startWidthSpring = {
    type: 'spring' as const,
    stiffness: 300,
    damping: 20,
    mass: 0.7,
    bounce: 0.6,
};

type FooterCenterSlotProps = {
    mode: FooterCenterMode;
    goalReady: boolean;
    localizeReady: boolean;
    onStart: () => void;
    onStop: () => void;
    onCancelPose: () => void;
    onConfirmPose: () => void;
};

/**
 * The AutoNav footer's center control. One presence child so Start, Stop,
 * and Cancel / Localize share the same exit, including ignoring taps.
 */
export function FooterCenterSlot({
    mode,
    goalReady,
    localizeReady,
    onStart,
    onStop,
    onCancelPose,
    onConfirmPose,
}: FooterCenterSlotProps) {
    return (
        <AnimatePresence mode="wait" initial={false}>
            <motion.div
                key={mode}
                className={
                    mode === 'pose'
                        ? 'footer-robot-pose-actions'
                        : 'footer-center-slot'
                }
                initial={footerCenterMotion.initial}
                animate={footerCenterMotion.animate}
                exit={footerCenterMotion.exit}
                transition={footerCenterTransition}
            >
                {mode === 'pose' ? (
                    <>
                        <MagneticWrapper>
                            <button
                                type="button"
                                className="footer-pose-button footer-pose-button--cancel"
                                onClick={onCancelPose}
                            >
                                Cancel
                            </button>
                        </MagneticWrapper>
                        <MagneticWrapper>
                            <button
                                type="button"
                                className="footer-pose-button footer-pose-button--localize"
                                onClick={onConfirmPose}
                                disabled={!localizeReady}
                                aria-disabled={!localizeReady}
                            >
                                Localize
                            </button>
                        </MagneticWrapper>
                    </>
                ) : mode === 'stop' ? (
                    <MagneticWrapper>
                        <button
                            type="button"
                            className="cancel-auto-nav-button"
                            onClick={onStop}
                        >
                            <span>Stop</span>
                            <StopCircleIcon className="cancel-auto-nav-icon" />
                        </button>
                    </MagneticWrapper>
                ) : (
                    <MagneticWrapper>
                        <motion.button
                            type="button"
                            className="auto-nav-button"
                            onClick={onStart}
                            disabled={!goalReady}
                            initial={false}
                            animate={{ width: goalReady ? 100 : 70 }}
                            transition={startWidthSpring}
                            style={{ overflow: 'hidden', display: 'inline-flex', alignItems: 'center' }}
                        >
                            <span>Start</span>
                            <motion.img
                                src={StartNavIcon}
                                className="auto-nav-button-icon"
                                initial={{ x: 20, opacity: 0, width: 0, marginLeft: 0, filter: 'brightness(1)' }}
                                animate={goalReady
                                    ? { x: 0, opacity: 1, width: 20, marginLeft: 8, filter: ['brightness(1)', 'brightness(1.7)', 'brightness(1)'] }
                                    : { x: 20, opacity: 0, width: 0, marginLeft: 0, filter: 'brightness(1)' }
                                }
                                transition={goalReady
                                    ? {
                                        type: 'spring',
                                        stiffness: 400,
                                        damping: 12,
                                        mass: 0.6,
                                        bounce: 0.7,
                                        filter: {
                                            duration: 2,
                                            repeat: Infinity,
                                            repeatType: 'loop',
                                            ease: 'easeInOut',
                                        },
                                    }
                                    : {
                                        type: 'spring',
                                        stiffness: 400,
                                        damping: 12,
                                        mass: 0.6,
                                        bounce: 0.7,
                                    }
                                }
                                style={{ display: 'inline-block' }}
                            />
                        </motion.button>
                    </MagneticWrapper>
                )}
            </motion.div>
        </AnimatePresence>
    );
}
