import React, { useEffect, useState } from "react";
import '../../css/PlaybackStatusbar.css';

export type StatusbarType = 'info' | 'info_bright' | 'success' | 'error' | 'warning' | 'textonly';

// Duration (ms) used for all statusbar CSS transitions (fade, slide)
export const ANIMS_STATUSBAR = 500;

// CSS gradient backgrounds for each statusbar type.
// Since CSS gradients can't be smoothly transitioned between,
// we render all four as stacked layers and crossfade via opacity.
//
// Uses hardware acceleration! 😇
const STATUSBAR_GRADIENTS: Record<StatusbarType, string> = {
    info: 'linear-gradient(0deg, hsla(0, 0%, 0%, 0.7) 0%, hsla(0, 0%, 0%, 0) 72%)',
    info_bright: 'linear-gradient(0deg, rgb(158 197 223 / 20%) 0%, rgba(255, 255, 255, 0) 72%) center bottom no-repeat',
    success: 'linear-gradient(0deg, rgba(0, 153, 255, 0.5) 0%, rgba(255, 255, 255, 0) 72%)',
    error: 'linear-gradient(0deg, hsla(330, 80%, 40%, 1) 0%, hsla(0, 0%, 0%, 0) 72%)',
    warning: 'linear-gradient(0deg, hsla(40, 90%, 60%, 1) 0%, hsla(0, 0%, 0%, 0) 72%)',
    textonly: 'none',
};

interface PlaybackStatusbarProps {
    /** Whether the statusbar is currently shown */
    isVisible: boolean;
    /** The semantic type controlling the gradient color */
    type: StatusbarType;
    /** Content rendered inside the statusbar (e.g. recording name + icon) */
    children: React.ReactNode;
}

/**
 * A bottom-anchored statusbar that shows playback state (playing, success, canceled, etc.).
 *
 * Visibility is controlled externally via `isVisible`. The gradient background
 * is determined by `type`, crossfading between stacked layers since CSS gradients
 * don't support native transitions.
 *
 * When hidden, `displayType` resets to 'info' after the exit animation completes,
 * so the next reveal always starts from the neutral state.
 */
export const PlaybackStatusbar: React.FC<PlaybackStatusbarProps> = ({
    isVisible,
    type,
    children,
}) => {
    // Internal type that drives which gradient layer is opaque.
    // Decoupled from the `type` prop so we can reset it to 'info'
    // after the hide transition finishes.
    const [displayType, setDisplayType] = useState<StatusbarType>('info');

    useEffect(() => {
        if (isVisible) {
            // Immediately reflect the requested type when shown
            setDisplayType(type);
        } else {
            // Wait for the fade-out transition to finish,
            // then reset to the neutral 'info' gradient
            const timer = setTimeout(() => setDisplayType('info'), ANIMS_STATUSBAR);
            return () => clearTimeout(timer);
        }
    }, [isVisible, type]);

    return (
        <div
            className="playback-statusbar"
            style={{
                position: 'absolute',
                left: 4,
                bottom: 9,
                width: 'calc(100% - 6px)',
                height: 50,
                opacity: isVisible ? 1 : 0,
                transition: `opacity ${ANIMS_STATUSBAR}ms ease-out`,
                borderRadius: 21,
                borderBottomRightRadius: 21,
                borderBottomLeftRadius: 21,
                overflow: 'hidden',
            }}
        >

            {/* Render one absolutely-positioned div per gradient type.
                Only the active `displayType` layer has opacity 1;
                the rest are transparent, creating a crossfade effect. */}
            {(Object.keys(STATUSBAR_GRADIENTS) as StatusbarType[]).map((gradientType) => {
                const isActive = displayType === gradientType && gradientType !== 'textonly';
                return (
                    <div
                        key={gradientType}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            opacity: displayType === gradientType ? 1 : 0,
                            background: STATUSBAR_GRADIENTS[gradientType],
                            backgroundPosition: 'bottom',
                            backgroundRepeat: 'no-repeat',
                            transformOrigin: 'bottom',
                            willChange: 'transform, opacity',
                            animation: isActive ? 'statusbar-breathe 7s ease-out infinite' : 'none',
                            // Slide up into view when visible, slide down when hidden
                            transform: isVisible ? 'translateY(0%)' : 'translateY(100%)',
                            transition: `opacity ${ANIMS_STATUSBAR}ms ease-out, transform ${ANIMS_STATUSBAR}ms ease-out`,
                            pointerEvents: 'none',
                        }}
                    />
                );
            })}

            {/* Text / icon content, layered above the gradient backgrounds */}
            <div style={{
                zIndex: 1,
                position: 'absolute',
                display: 'flex',
                justifyContent: 'center',
                width: '100%',
                bottom: 7,
                fontWeight: 600,
                fontSize: 14,
                opacity: isVisible ? 1 : 0,
                transition: `opacity ${ANIMS_STATUSBAR}ms ease-out`,
                textShadow: '0 0.5px 10px rgba(0, 0, 0, 0.5)',

            }}>
                {children}
            </div>
        </div >
    );
};

export default PlaybackStatusbar;
