/**
 * Only one modal (ModalMobile / MainMenu) can be open at a time.
 * Call at each modal's `isOpen` owner. Opening one closes any other.
 * Identity is this hook instance's close ref, so a new modal only calls the hook.
 * Veil-using modals pass `restoreVeil`; others omit it.
 */

import { useEffect, useRef } from "react";

type ModalClose = () => void;
type ModalSlot = { current: ModalClose };

const closeBySlot = new Map<ModalSlot, ModalClose>();
let openSlot: ModalSlot | null = null;

export type ExclusiveModalOptions = {
    /**
     * Re-assert camera veil after this modal wins exclusivity.
     * Stolen close turns veil off; veil-using winners must turn it back on.
     */
    restoreVeil?: (visible: boolean) => void;
};

/**
 * Ensures only one modal is open at a time.
 * When `isOpen` becomes true, any other registered modal is closed.
 */
export function useExclusiveModal(
    isOpen: boolean,
    close: ModalClose,
    options?: ExclusiveModalOptions,
): void {
    const closeRef = useRef(close);
    closeRef.current = close;
    const restoreVeilRef = useRef(options?.restoreVeil);
    restoreVeilRef.current = options?.restoreVeil;

    useEffect(() => {
        const slot = closeRef;
        closeBySlot.set(slot, () => closeRef.current());
        return () => {
            closeBySlot.delete(slot);
            if (openSlot === slot) {
                openSlot = null;
            }
        };
    }, []);

    useEffect(() => {
        if (isOpen) {
            if (openSlot && openSlot !== closeRef) {
                closeBySlot.get(openSlot)?.();
            }
            openSlot = closeRef;
            restoreVeilRef.current?.(true);
            return;
        }
        if (openSlot === closeRef) {
            openSlot = null;
        }
    }, [isOpen]);
}
