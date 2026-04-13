import React, { useRef } from 'react';
import { motion, type Variants } from 'framer-motion';

import 'operator/css/HelperText.css';

const EASE_IN = [0.22, 1, 0.36, 1,] as const;
const EASE_OUT = [0.55, 0, 0.45, 1,] as const;

/** Vertical gap below anchor (half of font size); applied as translateY so layout stays collapsed. */
const OFFSET_Y = '0.5em';

/** Zero-height anchor: message is absolutely positioned, offset with translateY via motion `y`. */
const containerVariants: Variants = {
    off: {
        opacity: 0,
        visibility: 'hidden',
        x: -18,
        y: OFFSET_Y,
        pointerEvents: 'none',
        transition: { duration: 0, },
    },
    visible: {
        opacity: 1,
        visibility: 'visible',
        x: 0,
        y: OFFSET_Y,
        pointerEvents: 'auto',
        transition: {
            duration: 0.34,
            ease: EASE_IN,
        },
    },
    dismissed: {
        opacity: 0,
        visibility: 'hidden',
        x: 16,
        y: OFFSET_Y,
        pointerEvents: 'none',
        transition: {
            duration: 0.3,
            ease: EASE_IN,
            when: 'afterChildren',
        },
    },
};

const scanVariants: Variants = {
    idle: {
        x: '-125%',
        transition: {
            duration: 0.38,
            ease: EASE_OUT,
        },
    },
    visible: {
        x: '310%',
        transition: {
            duration: 0.66,
            delay: 0.1,
            ease: [0.28, 1, 0.48, 1,] as const,
        },
    },
};

export type HelperTextVariant = 'info' | 'warning' | 'error';

export type HelperTextProps = {
    show: boolean;
    variant: HelperTextVariant;
    /** Pixel size; passed to `font-size` (React treats numbers as `px`). */
    fontSize: number;
    children: React.ReactNode;
    id?: string;
    className?: string;
    /** When false, message shows/hides instantly without motion or "scan" effect. @default true */
    isAnimated?: boolean;
};

/** Inline helper: zero-height anchor + absolutely positioned line; fade/slide + scan when `isAnimated`. */
export function HelperText({
    show,
    variant,
    fontSize,
    children,
    id,
    className,
    isAnimated = true,
}: HelperTextProps) {
    const hasEverBeenVisibleRef = useRef(false);
    if (show) {
        hasEverBeenVisibleRef.current = true;
    }

    const a11yRole = variant === 'info' ? 'status' : 'alert';
    const rootClass = [
        'helper-text',
        `helper-text--${variant}`,
        className,
    ].filter(Boolean).join(' ');

    const style: React.CSSProperties = { fontSize, };

    if (!isAnimated) {
        return (
            <div className="helper-text-anchor">
                <p
                    id={id}
                    className={rootClass}
                    style={{
                        ...style,
                        visibility: show ? 'visible' : 'hidden',
                        opacity: show ? 1 : 0,
                        pointerEvents: show ? 'auto' : 'none',
                        transform: `translateY(${OFFSET_Y})`,
                    }}
                    role={show ? a11yRole : undefined}
                    aria-hidden={!show}
                >
                    <span className="helper-text__text">{children}</span>
                </p>
            </div>
        );
    }

    const containerState = show
        ? 'visible'
        : hasEverBeenVisibleRef.current
            ? 'dismissed'
            : 'off';

    return (
        <div className="helper-text-anchor">
            <motion.p
                id={id}
                className={rootClass}
                style={style}
                role={show ? a11yRole : undefined}
                aria-hidden={!show}
                variants={containerVariants}
                initial={false}
                animate={containerState}
            >
                <span className="helper-text__text">
                    {children}
                </span>
                <motion.span
                    className="helper-text__scan"
                    variants={scanVariants}
                    initial={false}
                    animate={show ? 'visible' : 'idle'}
                    aria-hidden
                />
            </motion.p>
        </div>
    );
}
