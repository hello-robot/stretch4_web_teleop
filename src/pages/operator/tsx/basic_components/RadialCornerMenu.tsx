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

// Bounding boxes for each sector (derived from clip-path geometry).
// Tightly sizing each hit div lets iOS Voice Control place labels at the
// visual centre of each sector instead of at the centre of a shared 150×150 box.
const SECTOR_BOUNDS = [
    { left: 52.9326, top: 76.7387, width: 97.0674, height: 73.2613 }, // sector 0
    { left: 31.7154, top: 21.1077, width: 97.1769, height: 97.1769 }, // sector 1
    { left: 0, top: 0, width: 73.2613, height: 97.0674 },             // sector 2
];

// Clip-path strings translated to each sector's local coordinate system
const SECTOR_CLIP_PATHS = [
    'path("M 7.0674 73.2613 L 97.0674 73.2613 A 150 150 0 0 0 77.9597 0 L 0 45.01 A 60 60 0 0 1 7.0674 73.2613 Z")',
    'path("M 19.2172 97.1769 L 97.1769 52.1669 A 150 150 0 0 0 45.01 0 L 0 77.9597 A 60 60 0 0 1 19.2172 97.1769 Z")',
    'path("M 28.2513 97.0674 L 73.2613 19.1077 A 150 150 0 0 0 0 0 L 0 90 A 60 60 0 0 1 28.2513 97.0674 Z")',
];

// Icon centre positions (px, relative to the 150x150 box)
const ICON_CENTERS = [
    { x: 101.4222, y: 122.824 }, // sector 0, mid=15 deg
    { x: 74.2462, y: 75.7538 }, // sector 1, mid=45 deg
    { x: 27.176, y: 48.5778 }, // sector 2, mid=75 deg
];

const CLOSE_BOUNDS = { left: 0, top: 90, width: 60, height: 60 };
const CLOSE_CLIP_PATH =
    'path("M 0 60 L 0 0 A 60 60 0 0 1 60 60 Z")';

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

const BASE_MENU_SIZE = 150;
const MENU_SIZE = 150;
const MENU_SCALE = MENU_SIZE / BASE_MENU_SIZE;
const ICON_SIZE = 35;

const scaleValue = (value: number) => value * MENU_SCALE;

const SCALED_SECTOR_BOUNDS = SECTOR_BOUNDS.map((bounds) => ({
    left: scaleValue(bounds.left),
    top: scaleValue(bounds.top),
    width: scaleValue(bounds.width),
    height: scaleValue(bounds.height),
}));

const SCALED_SECTOR_CLIP_PATHS = SECTOR_CLIP_PATHS;

const SCALED_ICON_CENTERS = ICON_CENTERS.map((center) => ({
    x: scaleValue(center.x),
    y: scaleValue(center.y),
}));

const SCALED_CLOSE_BOUNDS = {
    left: scaleValue(CLOSE_BOUNDS.left),
    top: scaleValue(CLOSE_BOUNDS.top),
    width: scaleValue(CLOSE_BOUNDS.width),
    height: scaleValue(CLOSE_BOUNDS.height),
};

const SCALED_CLOSE_CLIP_PATH = CLOSE_CLIP_PATH;
const SCALED_ICON_SIZE = scaleValue(ICON_SIZE);
const ACCESSIBLE_TARGET_SIZE = 50;

const getIconTargetBounds = (index: number) => {
    const center = SCALED_ICON_CENTERS[index];
    return {
        left: center.x - ACCESSIBLE_TARGET_SIZE / 2,
        top: center.y - ACCESSIBLE_TARGET_SIZE / 2,
        width: ACCESSIBLE_TARGET_SIZE,
        height: ACCESSIBLE_TARGET_SIZE,
    };
};

const CLOSE_TARGET_BOUNDS = {
    left: 0,
    top: MENU_SIZE - ACCESSIBLE_TARGET_SIZE,
    width: ACCESSIBLE_TARGET_SIZE,
    height: ACCESSIBLE_TARGET_SIZE,
};

// Memoised sector to avoid re-renders during the parent scale animation
const RadialSector = React.memo<{
    index: number;
    isSelected: boolean;
    onClick: () => void;
}>(({ index, isSelected, onClick }) => {
    const b = SCALED_SECTOR_BOUNDS[index];
    return (
        <div
            className="radial-sector-hit"
            aria-hidden="true"
            style={{
                left: b.left,
                top: b.top,
                width: b.width,
                height: b.height,
                clipPath: SCALED_SECTOR_CLIP_PATHS[index],
            }}
            onClick={onClick}
        >
            <img
                src={SECTOR_SVGS[index]}
                className="radial-layer"
                style={{ left: -b.left, top: -b.top }}
                alt=""
                draggable={false}
            />
            <img
                src={SECTOR_ACTIVE_SVGS[index]}
                className="radial-layer radial-active-glow"
                style={{ opacity: isSelected ? 1 : 0, left: -b.left, top: -b.top }}
                alt=""
                draggable={false}
            />
        </div>
    );
});

const RadialIconButton = React.memo<{
    index: number;
    iconSrc: string;
    label: string;
    onClick: () => void;
}>(({ index, iconSrc, label, onClick }) => {
    const c = SCALED_ICON_CENTERS[index];
    const bounds = getIconTargetBounds(index);
    return (
        <button
            type="button"
            className="radial-icon-button"
            aria-label={label}
            style={{
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
            }}
            onClick={onClick}
        >
            <img
                src={iconSrc}
                className="radial-icon-overlay"
                style={{
                    left: c.x - bounds.left,
                    top: c.y - bounds.top,
                    width: SCALED_ICON_SIZE,
                    height: SCALED_ICON_SIZE,
                }}
                alt=""
                aria-hidden="true"
                draggable={false}
            />
        </button>
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
        [],
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
                        document.body,
                    )}
            </AnimatePresence>

            {/* Radial menu — always in the DOM so images are pre-decoded.
                Visibility is driven by framer-motion's animate prop. */}
            <motion.div
                className="radial-corner-menu-wrapper"
                aria-hidden={!isOpen}
                initial={false}
                animate={
                    isOpen
                        ? { scale: 1, opacity: 1 }
                        : { scale: 0, opacity: 0 }
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
                        <RadialIconButton
                            key={`icon-${i}`}
                            index={i}
                            iconSrc={opt.iconSrc}
                            label={opt.label}
                            onClick={() =>
                                handleOptionClick(opt.label, opt.onClick)
                            }
                        />
                    );
                })}

                {/* Close button */}
                <div
                    className="radial-sector-hit radial-close-hit"
                    aria-hidden="true"
                    style={{
                        left: SCALED_CLOSE_BOUNDS.left,
                        top: SCALED_CLOSE_BOUNDS.top,
                        width: SCALED_CLOSE_BOUNDS.width,
                        height: SCALED_CLOSE_BOUNDS.height,
                        clipPath: SCALED_CLOSE_CLIP_PATH,
                    }}
                    onClick={onClose}
                >
                    <img
                        src={radialClose}
                        className="radial-layer"
                        style={{
                            left: -SCALED_CLOSE_BOUNDS.left,
                            top: -SCALED_CLOSE_BOUNDS.top,
                        }}
                        alt="Close"
                        draggable={false}
                    />
                </div>

                <button
                    type="button"
                    className="radial-icon-button radial-close-button"
                    aria-label="Close"
                    style={{
                        left: CLOSE_TARGET_BOUNDS.left,
                        top: CLOSE_TARGET_BOUNDS.top,
                        width: CLOSE_TARGET_BOUNDS.width,
                        height: CLOSE_TARGET_BOUNDS.height,
                    }}
                    onClick={onClose}
                />
            </motion.div>
        </div>
    );
};
