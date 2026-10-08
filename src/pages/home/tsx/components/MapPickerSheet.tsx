import checkOn from "home/public/icons/check-on.svg";
import mapMarkerIcon from "home/public/icons/map-marker.svg";
import React from "react";
import { MapIndex } from "../robotModel";
import { BottomSheet } from "./BottomSheet";

interface MapPickerSheetProps {
    open: boolean;
    maps: MapIndex;
    selectedMapId: string | null;
    onClose: () => void;
    onSelect: (mapId: string | null) => void;
}

export const MapPickerSheet = ({ open, maps, selectedMapId, onClose, onSelect }: MapPickerSheetProps) => (
    <BottomSheet open={open} title="Map" icon={mapMarkerIcon} onClose={onClose}>
        <ul className="hr-sheet__list">
            <li>
                <button
                    type="button"
                    className="hr-sheet__option"
                    aria-pressed={selectedMapId === null}
                    onClick={() => onSelect(null)}
                >
                    <span className="hr-sheet__thumb hr-sheet__thumb--empty">none</span>
                    <span className="hr-sheet__option-text">
                        <span>No map</span>
                        <span className="hr-sheet__option-desc">Launch without AutoNav</span>
                    </span>
                    {selectedMapId === null && <img alt="" className="hr-sheet__check" src={checkOn} />}
                </button>
            </li>
            {Object.entries(maps).map(([mapId, map]) => (
                <li key={mapId}>
                    <button
                        type="button"
                        className="hr-sheet__option"
                        aria-pressed={selectedMapId === mapId}
                        onClick={() => onSelect(mapId)}
                    >
                        {map.thumb_png_base64 ? (
                            <img
                                alt=""
                                className="hr-sheet__thumb"
                                src={`data:image/png;base64,${map.thumb_png_base64}`}
                            />
                        ) : (
                            <span className="hr-sheet__thumb hr-sheet__thumb--empty">map</span>
                        )}
                        <span className="hr-sheet__option-text">
                            <span>{map.name || mapId}</span>
                        </span>
                        {selectedMapId === mapId && <img alt="" className="hr-sheet__check" src={checkOn} />}
                    </button>
                </li>
            ))}
        </ul>
    </BottomSheet>
);
