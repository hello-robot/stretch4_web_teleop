import React, { useState, useEffect, useCallback, ReactNode } from "react";
import chevronIcon from "operator/icons/ChevronDown.svg";
import "operator/css/MainMenu.css";

export type AnimationState = "" | "enter" | "exit";

interface MainMenuProps {
    isOpen: boolean;
    title: string
    onClose?: () => void;
    children: ReactNode;
    footer?: ReactNode;
    modalClassName?: string;
    overlayClassName?: string;
    hasBgColor?: boolean;
}

/**
 * MainMenu is the foundational menu UX for navigating
 * between: a) scenes b) movement recordings c) settings and more.
 */

const MainMenu: React.FC<MainMenuProps> = ({
    isOpen,
    title,
    onClose = () => { },
    children,
    footer,
    modalClassName = "",
    overlayClassName = "",
    hasBgColor = false,
}) => {
    const [visible, setVisible] = useState<boolean>(isOpen);
    const [animState, setAnimState] = useState<AnimationState>("");

    useEffect(() => {
        if (isOpen) {
            setVisible(true);
            requestAnimationFrame(() => setAnimState("enter"));
        } else if (visible) {
            setAnimState("exit");
        }
    }, [isOpen, visible]);

    const onAnimationEnd = useCallback(
        (e: React.AnimationEvent<HTMLDialogElement | HTMLDivElement>) => {
            // Ensure the animation event is from the modal itself and not a child
            if (
                (e.target as HTMLElement).classList.contains(
                    "main-menu-modal-content-wrapper"
                ) &&
                animState === "exit"
            ) {
                setVisible(false);
                setAnimState("");
                // Call onClose here if the modal is fully closed and not just hidden by animation
                // However, onClose is typically tied to user action or isOpen prop change.
                // If onClose needs to be called after animation, it should be handled carefully.

                onClose();
            }
        },
        [animState]
    );

    const handleOverlayClick = (e: React.MouseEvent<HTMLDialogElement>) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };
    if (!visible) return null;

    return (
        <dialog
            className={`main-menu-modal-overlay ${animState} ${overlayClassName}`}
            onClick={handleOverlayClick}
            onAnimationEnd={animState === "exit" ? onAnimationEnd : undefined}
            role="dialog"
            aria-modal="true"
            aria-hidden={!visible}
            tabIndex={0}
        >
            <div
                className={`main-menu-modal-content-wrapper ${animState} ${modalClassName} ${hasBgColor ? "has-bg-color" : ""}`}
                onAnimationEnd={onAnimationEnd} // Listen to modal slide animation
            >
                <div className="main-menu-modal-header">
                    <div className="chevron-wrapper">
                        <img
                            className="chevron"
                            src={chevronIcon}
                            alt=""
                            aria-hidden="true"
                            role="presentation"
                        />
                    </div>
                    <h2 className="main-menu-modal-title" aria-hidden="true">
                        {title}
                    </h2>
                </div>
                <div className="main-menu-modal-body">{children}</div>
                {footer && (
                    <div className="main-menu-modal-footer">{footer}</div>
                )}
            </div>
        </dialog>
    );
};

export default MainMenu;
