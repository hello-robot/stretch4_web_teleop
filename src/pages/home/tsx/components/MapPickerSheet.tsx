import checkOn from "home/public/icons/check-on.svg";
import mapMarkerIcon from "home/public/icons/map-marker.svg";
import React from "react";
import { MapIndex } from "../robotModel";
import { BottomSheet } from "./BottomSheet";
import { SheetActions } from "./SheetActions";

interface MapPickerSheetProps {
    open: boolean;
    maps: MapIndex;
    selectedMapId: string | null;
    interfaceActive: boolean;
    occupiedBy: string | null;
    busy: boolean;
    onClose: () => void;
    onApply: (mapId: string | null) => void;
}

/**
 * The pick is staged rather than written on tap, so Discard can leave a running
 * interface untouched. The daemon loads the map once per launch, so an apply
 * against a running interface has to relaunch it -- otherwise the card would
 * name a map the robot is not using.
 */
export const MapPickerSheet = ({
    open,
    maps,
    selectedMapId,
    interfaceActive,
    occupiedBy,
    busy,
    onClose,
    onApply,
}: MapPickerSheetProps) => {
    // undefined means untouched this visit; null is a real pick ("No map").
    const [draft, draftSet] = React.useState<string | null | undefined>(
        undefined
    );

    // Re-seed on every open so a discarded pick never reappears later.
    React.useEffect(() => {
        if (open) draftSet(undefined);
    }, [open]);

    const picked = draft === undefined ? selectedMapId : draft;

    return (
        <BottomSheet
            open={open}
            title="Map"
            icon={mapMarkerIcon}
            onClose={onClose}
        >
            <ul className="hr-sheet__list">
                <li>
                    <button
                        type="button"
                        className="hr-sheet__option"
                        aria-pressed={picked === null}
                        onClick={() => draftSet(null)}
                    >
                        <span className="hr-sheet__thumb hr-sheet__thumb--empty">
                            none
                        </span>
                        <span className="hr-sheet__option-text">
                            <span>No map</span>
                            <span className="hr-sheet__option-desc">
                                Launch without AutoNav
                            </span>
                        </span>
                        {picked === null && (
                            <img
                                alt=""
                                className="hr-sheet__check"
                                src={checkOn}
                            />
                        )}
                    </button>
                </li>
                {Object.entries(maps).map(([mapId, map]) => (
                    <li key={mapId}>
                        <button
                            type="button"
                            className="hr-sheet__option"
                            aria-pressed={picked === mapId}
                            onClick={() => draftSet(mapId)}
                        >
                            {map.thumb_png_base64 ? (
                                <img
                                    alt=""
                                    className="hr-sheet__thumb"
                                    src={`data:image/png;base64,${map.thumb_png_base64}`}
                                />
                            ) : (
                                <span className="hr-sheet__thumb hr-sheet__thumb--empty">
                                    map
                                </span>
                            )}
                            <span className="hr-sheet__option-text">
                                <span>{map.name || mapId}</span>
                            </span>
                            {picked === mapId && (
                                <img
                                    alt=""
                                    className="hr-sheet__check"
                                    src={checkOn}
                                />
                            )}
                        </button>
                    </li>
                ))}
            </ul>

            <SheetActions
                interfaceActive={interfaceActive}
                occupiedBy={occupiedBy}
                busy={busy}
                onDiscard={onClose}
                onApply={() => onApply(picked)}
            />
        </BottomSheet>
    );
};
