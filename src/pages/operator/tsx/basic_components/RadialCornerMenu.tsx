import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import "operator/css/RadialCornerMenu.css";

import radialSector0 from "operator/icons/Radial_Sector_0.svg";
import radialSector1 from "operator/icons/Radial_Sector_1.svg";
import radialSector2 from "operator/icons/Radial_Sector_2.svg";
import radialSector0Active from "operator/icons/Radial_Sector_0_Active.svg";
import radialSector1Active from "operator/icons/Radial_Sector_1_Active.svg";
import radialSector2Active from "operator/icons/Radial_Sector_2_Active.svg";
import radialBackground from "operator/icons/Radial_Background.svg";
import radialClose from "operator/icons/Radial_Close.svg";

// Pre-computed sector assets in index order
const SECTOR_SVGS = [radialSector0, radialSector1, radialSector2];

// Pre-computed active glow assets in index order (must correspond to SECTOR_SVGS)
const SECTOR_ACTIVE_SVGS = [
    radialSector0Active,
    radialSector1Active,
    radialSector2Active,
];

// Clip-path strings for pointer-event hit-testing (match the sector SVG shapes)
const SECTOR_CLIP_PATHS = [
    'path("M 60 150 L 150 150 A 150 150 0 0 0 130.8923 76.7387 L 52.9326 121.7487 A 60 60 0 0 1 60 150 Z")',
    'path("M 50.9326 118.2846 L 128.8923 73.2746 A 150 150 0 0 0 76.7254 21.1077 L 31.7154 99.0674 A 60 60 0 0 1 50.9326 118.2846 Z")',
    'path("M 28.2513 97.0674 L 73.2613 19.1077 A 150 150 0 0 0 0 0 L 0 90 A 60 60 0 0 1 28.2513 97.0674 Z")',
];

// Icon centre positions (px, relative to the 150x150 box)
const ICON_CENTERS = [
    { x: 101.4222, y: 122.824 }, // sector 0, mid=15 deg
    { x: 74.2462, y: 75.7538 }, // sector 1, mid=45 deg
    { x: 27.176, y: 48.5778 }, // sector 2, mid=75 deg
];

const CLOSE_CLIP_PATH = 'path("M 0 150 L 0 90 A 60 60 0 0 1 60 150 Z")';

// ---------------------------------------------------------------------------

export interface RadialCornerMenuOption {
    iconSrc?: string;
    label: string;
    onClick: () => void;
}

interface RadialCornerMenuProps {
    isOpen: boolean;
    onClose: () => void;
    options: RadialCornerMenuOption[];
    selectedLabel?: string;
}

const ICON_SIZE = 35;

// Memoised sector to avoid re-renders during the parent scale animation
const RadialSector = React.memo<{
    index: number;
    isSelected: boolean;
    onClick: () => void;
}>(({ index, isSelected, onClick }) => (
    <div
        className="radial-sector-hit"
        style={{ clipPath: SECTOR_CLIP_PATHS[index] }}
        onClick={onClick}
    >
        <img
            src={SECTOR_SVGS[index]}
            className="radial-layer"
            alt=""
            draggable={false}
        />
        <img
            src={SECTOR_ACTIVE_SVGS[index]}
            className="radial-layer radial-active-glow"
            style={{ opacity: isSelected ? 1 : 0 }}
            alt=""
            draggable={false}
        />
    </div>
));

// Memoised icon overlay
const RadialIcon = React.memo<{
    index: number;
    iconSrc: string;
    label: string;
}>(({ index, iconSrc, label }) => {
    const c = ICON_CENTERS[index];
    return (
        <img
            src={iconSrc}
            className="radial-icon-overlay"
            style={{
                left: c.x,
                top: c.y,
                width: ICON_SIZE,
                height: ICON_SIZE,
            }}
            alt={label}
            draggable={false}
        />
    );
});

export const RadialCornerMenu: React.FC<RadialCornerMenuProps> = ({
    isOpen,
    onClose,
    options,
    selectedLabel,
}) => {
    // Internal state to handle selection animation delay
    const [localSelected, setLocalSelected] = React.useState(selectedLabel);

    React.useEffect(() => {
        setLocalSelected(selectedLabel);
    }, [selectedLabel, isOpen]);

    const handleOptionClick = React.useCallback(
        (label: string, onClick: () => void) => {
            setLocalSelected(label);
            setTimeout(onClick, 500);
        },
        []
    );

    return (
        <div className="radial-corner-menu-container">
            {/* Portal the overlay to document.body so it escapes
                the overflow:hidden container */}
            <AnimatePresence>
                {isOpen &&
                    createPortal(
                        <motion.div
                            key="radial-overlay"
                            className="radial-corner-menu-overlay"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.25 }}
                            onClick={onClose}
                        />,
                        document.body
                    )}
            </AnimatePresence>

            {/* Radial menu — always in the DOM so images are pre-decoded.
                Visibility is driven by framer-motion's animate prop. */}
            <motion.div
                className="radial-corner-menu-wrapper"
                initial={false}
                animate={
                    isOpen ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }
                }
                transition={{
                    type: "spring",
                    duration: 0.4,
                    bounce: 0.15,
                }}
                style={{ pointerEvents: isOpen ? "all" : "none" }}
            >
                {/* Background layer */}
                <img
                    src={radialBackground}
                    className="radial-layer"
                    alt=""
                    draggable={false}
                />

                {/* Sector layers — default + active glow */}
                {options.map((opt, i) => {
                    if (i >= SECTOR_SVGS.length) return null;
                    return (
                        <RadialSector
                            key={i}
                            index={i}
                            isSelected={opt.label === localSelected}
                            onClick={() =>
                                handleOptionClick(opt.label, opt.onClick)
                            }
                        />
                    );
                })}

                {/* Icon overlays */}
                {options.map((opt, i) => {
                    if (i >= ICON_CENTERS.length || !opt.iconSrc) return null;
                    return (
                        <RadialIcon
                            key={`icon-${i}`}
                            index={i}
                            iconSrc={opt.iconSrc}
                            label={opt.label}
                        />
                    );
                })}

                {/* Close button */}
                <div
                    className="radial-sector-hit radial-close-hit"
                    style={{ clipPath: CLOSE_CLIP_PATH }}
                    onClick={onClose}
                >
                    <img
                        src={radialClose}
                        className="radial-layer"
                        alt="Close"
                        draggable={false}
                    />
                </div>
            </motion.div>
        </div>
    );
};
