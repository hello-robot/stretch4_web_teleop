import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import genUUID from '../utils/genUUID';
import '../../css/Toasts.css';

export type ToastVariant = 'voice';

export interface Toast {
    id: string;
    type: 'success' | 'error' | 'info';
    message: string;
    duration?: number;
    closeButton?: boolean;
    variant?: ToastVariant;
}

export type AddToastFn = (
    type: Toast['type'],
    message: string,
    duration?: number,
    variant?: ToastVariant,
) => void;

/** Toast queue state and enqueue helper for operator-level hosts. */
export function useToasts() {
    const [toasts, toastsSet] = useState<Toast[]>([]);

    const addToast = useCallback<AddToastFn>((type, message, duration, variant) => {
        const id = genUUID();
        toastsSet((prevToasts) => [
            ...prevToasts,
            { id, type, message, duration, variant },
        ]);
    }, []);

    return { toasts, toastsSet, addToast };
}

/**
 * Toast component that displays a notification message.
 * @param {ToastProps} props - The properties for the toast.
 * @returns {JSX.Element} The rendered toast component.
 */
const Toast: React.FC<Toast> = ({
    id,
    type = 'info',
    message,
    duration = 3000,
    closeButton = false,
    variant,
}) => {
    const [isVisible, setIsVisible] = useState<boolean>(true);

    useEffect(() => {
        // If duration is -1 don't
        // auto-dismiss the toast...
        if (duration === -1) return;
        // ..else setTimeout() to auto-dismiss toast
        if (duration > 0) {
            const timer = setTimeout(() => {
                setIsVisible(false);
            }, duration);

            return () => clearTimeout(timer);
        }
    }, [id, duration]);

    const typeClass = variant === 'voice' ? 'toast-voice' : `toast-${type}`;

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.3 }}
                    layout
                    className={`toast-notification ${typeClass}`}
                    aria-hidden
                >
                    <span className="toast-message">{message}</span>
                    {closeButton && <button
                        onClick={() => setIsVisible(false)}
                        className="toast-close"
                    >
                        ✕
                    </button>}
                </motion.div>
            )}
        </AnimatePresence>
    );
};

interface ToastsProps {
    toasts: Toast[];
    toastsSet: React.Dispatch<React.SetStateAction<Toast[]>>;
}

/**
 * Toasts component that manages and displays a list of toast notifications.
 * @param {ToastsProps} props - The properties for the toasts component.
 * @returns {JSX.Element} The rendered toasts component.
 */
const Toasts: React.FC<ToastsProps> = ({ toasts, toastsSet }) => {
    const removeToast = (id: string) => {
        toastsSet((prevToasts) => prevToasts.filter((toast) => toast.id !== id));
    };

    return (
        <div className="toast-container">
            <AnimatePresence>
                {toasts.slice().reverse().map((toast) => (
                    <motion.div
                        key={toast.id}
                        onAnimationComplete={(definition) => {
                            removeToast(toast.id);
                        }}
                    >
                        <Toast
                            id={toast.id}
                            type={toast.type}
                            message={toast.message}
                            duration={toast.duration}
                            variant={toast.variant}
                        />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
};

export default Toasts;
