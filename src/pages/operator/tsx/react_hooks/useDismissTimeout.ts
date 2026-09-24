import { useCallback, useEffect, useRef } from "react";

const DISMISS_DELAY_MS = 500;

/**
 * Wait 500ms, then run the close. If the modal is already gone, cancel
 * the wait so we do not hide the camera veil for a different open modal.
 */
export function useDismissTimeout(isOpen: boolean): (fn: () => void) => void {
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    const clear = useCallback(() => {
        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }
    }, []);

    const schedule = useCallback(
        (fn: () => void) => {
            clear();
            timerRef.current = setTimeout(() => {
                timerRef.current = undefined;
                fn();
            }, DISMISS_DELAY_MS);
        },
        [clear],
    );

    useEffect(() => {
        if (!isOpen) {
            clear();
        }
    }, [isOpen, clear]);

    useEffect(() => clear, [clear]);

    return schedule;
}
