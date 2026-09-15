/**
 * Only one modal (ModalMobile / MainMenu) can be open at a time.
 * Call at each modal's `isOpen` owner. Opening one closes any other.
 * Veil-using modals pass `restoreVeil`; others omit it.
 */

import { useEffect, useRef } from "react";

export type ExclusiveModalId =
    | "mainMenu"
    | "savedLocations"
    | "addLocation"
    | "savedPoses"
    | "actionSpeed"
    | "actionMode"
    | "cameraSwitcher";

type ModalClose = () => void;

const closeById = new Map<ExclusiveModalId, ModalClose>();
let openId: ExclusiveModalId | null = null;

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
    id: ExclusiveModalId,
    isOpen: boolean,
    close: ModalClose,
    options?: ExclusiveModalOptions,
): void {
    const closeRef = useRef(close);
    closeRef.current = close;
    const restoreVeilRef = useRef(options?.restoreVeil);
    restoreVeilRef.current = options?.restoreVeil;

    useEffect(() => {
        closeById.set(id, () => closeRef.current());
        return () => {
            closeById.delete(id);
            if (openId === id) {
                openId = null;
            }
        };
    }, [id]);

    useEffect(() => {
        if (isOpen) {
            if (openId && openId !== id) {
                closeById.get(openId)?.();
            }
            openId = id;
            restoreVeilRef.current?.(true);
            return;
        }
        if (openId === id) {
            openId = null;
        }
    }, [isOpen, id]);
}
