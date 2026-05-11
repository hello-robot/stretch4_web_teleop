import React, { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import MagneticWrapper from "../static_components/MagneticWrapper";
import "operator/css/ConfirmOverlay.css";

const confirmEase = [0.4, 0, 0.2, 1] as const;

const confirmOverlayVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: { duration: 0.22, ease: confirmEase },
    },
    exit: {
        opacity: 0,
        transition: { duration: 0.16, ease: confirmEase },
    },
};

const confirmDialogVariants = {
    hidden: { opacity: 0, y: 10, scale: 0.98 },
    visible: {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: { duration: 0.3, ease: confirmEase },
    },
    exit: {
        opacity: 0,
        y: 6,
        scale: 0.99,
        transition: { duration: 0.18, ease: confirmEase },
    },
};

const confirmTextLineVariants = {
    hidden: { opacity: 0, y: 6 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.28, ease: confirmEase, delay: 0.04 },
    },
};

const confirmActionsVariants = {
    hidden: {},
    visible: {
        transition: { staggerChildren: 0.055, delayChildren: 0.1 },
    },
};

const confirmButtonVariants = {
    hidden: { opacity: 0, y: 5 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.24, ease: confirmEase },
    },
};

export interface ConfirmOverlayProps {
    /** When false, the overlay is not mounted (AnimatePresence exit still runs on close). */
    open: boolean;
    /**
     * Key for the animated layer; change when `open` stays true but copy or context changes
     * so the entrance animation runs again.
     */
    presenceKey?: string;
    title?: ReactNode;
    body?: ReactNode;
    cancelLabel?: string;
    confirmLabel?: string;
    onCancel: () => void;
    onConfirm: () => void;
    /** Appended to `confirm-overlay` on the backdrop root. */
    className?: string;
    /** Appended to `confirm-overlay__dialog`. */
    dialogClassName?: string;
}

export const ConfirmOverlay: React.FC<ConfirmOverlayProps> = ({
    open,
    presenceKey = "confirm",
    title,
    body,
    cancelLabel = "Cancel",
    confirmLabel = "Confirm",
    onCancel,
    onConfirm,
    className = "",
    dialogClassName = "",
}) => (
    <AnimatePresence>
        {open ? (
            <motion.div
                key={presenceKey}
                className={["confirm-overlay", className].filter(Boolean).join(" ")}
                role="presentation"
                variants={confirmOverlayVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                        onCancel();
                    }
                }}
            >
                <motion.div
                    className={["confirm-overlay__dialog", dialogClassName].filter(Boolean).join(" ")}
                    variants={confirmDialogVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    onPointerDown={(e) => { e.stopPropagation(); }}
                >
                    {title != null ? (
                        <motion.p
                            className="confirm-overlay__title"
                            variants={confirmTextLineVariants}
                        >
                            {title}
                        </motion.p>
                    ) : null}
                    {body != null ? (
                        <motion.p
                            className="confirm-overlay__body"
                            variants={confirmTextLineVariants}
                        >
                            {body}
                        </motion.p>
                    ) : null}
                    <motion.div
                        className="confirm-overlay__actions"
                        variants={confirmActionsVariants}
                    >
                        <motion.div
                            className="confirm-overlay__action-slot"
                            variants={confirmButtonVariants}
                        >
                            <MagneticWrapper>
                                <button
                                    type="button"
                                    className="btn btn-tertiary"
                                    onPointerDown={onCancel}
                                >
                                    {cancelLabel}
                                </button>
                            </MagneticWrapper>
                        </motion.div>
                        <motion.div
                            className="confirm-overlay__action-slot"
                            variants={confirmButtonVariants}
                        >
                            <MagneticWrapper>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onPointerDown={onConfirm}
                                >
                                    {confirmLabel}
                                </button>
                            </MagneticWrapper>
                        </motion.div>
                    </motion.div>
                </motion.div>
            </motion.div>
        ) : null}
    </AnimatePresence>
);
