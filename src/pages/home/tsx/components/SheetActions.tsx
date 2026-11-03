import React from "react";

interface SheetActionsProps {
    /** The interface is running, so applying has to take it through a relaunch. */
    interfaceActive: boolean;
    /** Name of whoever is driving, when applying would end their session. */
    occupiedBy: string | null;
    /** An apply from this sheet is still in flight. */
    busy: boolean;
    onDiscard: () => void;
    onApply: () => void;
}

/**
 * Footer for the editing sheets. Both buttons stay present and keep their
 * accessible names in every state: the sheets are driven by voice control and
 * eye-gaze dwell, where a control that disappears or silently does nothing is
 * indistinguishable from a missed target.
 */
export const SheetActions = ({
    interfaceActive,
    occupiedBy,
    busy,
    onDiscard,
    onApply,
}: SheetActionsProps) => (
    <>
        {occupiedBy && (
            <p className="hr-sheet__warn" id="hr-sheet-occupied">
                {occupiedBy} is driving this robot. Applying disconnects them
                and relaunches the interface.
            </p>
        )}
        <div className="hr-sheet__actions">
            <button
                type="button"
                className="hr-button hr-button--ghost"
                onClick={onDiscard}
            >
                Discard
            </button>
            <button
                type="button"
                className="hr-button hr-button--primary"
                aria-disabled={busy}
                aria-describedby={occupiedBy ? "hr-sheet-occupied" : undefined}
                onClick={() => {
                    if (!busy) onApply();
                }}
            >
                {interfaceActive ? "Apply and Restart Interface" : "Apply"}
            </button>
        </div>
    </>
);
