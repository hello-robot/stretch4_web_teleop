import React from "react";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import chevronIcon from "operator/icons/Chevron.svg";
import gripperOpenIcon from "operator/icons/GripperOpen.svg";
import gripperCloseIcon from "operator/icons/GripperClose.svg";
import { StretchTool } from "shared/util";
import { SharedState } from "../layout_components/CustomizableComponent";
import {
    fgpadRatioVars,
    leftPanelOutlinePath,
    panelViewBox,
} from "../utils/flyingGripperGeometry";
import "operator/css/FlyingGripperPad.css";

type PadButton = {
    id: string;
    ariaLabel: string;
    isGripper?: boolean;
    iconSrc?: string;
    Icon?: React.ElementType;
};

const RING_BUTTONS: readonly PadButton[] = [
    {
        id: "north",
        ariaLabel: "Flying gripper: up",
        iconSrc: chevronIcon,
    },
    {
        id: "south",
        ariaLabel: "Flying gripper: down",
        iconSrc: chevronIcon,
    },
    {
        id: "west",
        ariaLabel: "Flying gripper: left",
        iconSrc: chevronIcon,
    },
    {
        id: "east",
        ariaLabel: "Flying gripper: right",
        iconSrc: chevronIcon,
    },
];

const INNER_BUTTONS: readonly PadButton[] = [
    {
        id: "up",
        ariaLabel: "Flying gripper: forward",
        Icon: ArrowUpwardIcon,
    },
    {
        id: "down",
        ariaLabel: "Flying gripper: backward",
        Icon: ArrowDownwardIcon,
    },
];

const BAR_LEFT: PadButton = {
    id: "gripper-open",
    ariaLabel: "Flying gripper: open gripper",
    isGripper: true,
    iconSrc: gripperOpenIcon,
};

const BAR_RIGHT: PadButton = {
    id: "gripper-close",
    ariaLabel: "Flying gripper: close gripper",
    isGripper: true,
    iconSrc: gripperCloseIcon,
};

const PadButtonEl: React.FC<{
    button: PadButton;
    className: string;
    disabled: boolean;
    children?: React.ReactNode;
}> = ({ button, className, disabled, children }) => {
    const clickProps = disabled ? {} : { onPointerDown: () => {} };
    return (
        <button
            type="button"
            className={className}
            aria-label={button.ariaLabel}
            disabled={disabled}
            {...clickProps}
        >
            {children}
            {button.iconSrc ? (
                <img
                    src={button.iconSrc}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="fgpad-icon fgpad-icon--svg"
                />
            ) : button.Icon ? (
                <button.Icon className="fgpad-icon" />
            ) : null}
        </button>
    );
};

/** `--r-*` ratio vars consumed by FlyingGripperPad.css (computed once). */
const RATIO_STYLE = fgpadRatioVars() as React.CSSProperties;

const PANEL_OUTLINE_PATH = leftPanelOutlinePath();
const PANEL_VIEW_BOX = panelViewBox();

/**
 * Panel outline drawn as one SVG path so the bite arc can meet the straight
 * edges with real fillets (CSS borders cannot round that junction). The ridge
 * look is emulated with a two-tone stroke: a full-width stroke (its outer half
 * shows outside the shape) plus a second stroke clipped to the interior. Strokes
 * are non-scaling so they stay at --pad-border-width like the CSS-bordered wedges.
 */
const PanelOutline: React.FC<{ side: "left" | "right" }> = ({ side }) => {
    const clipId = `fgpad-panel-interior-${side}`;
    return (
        <svg
            className={`fgpad-panel-outline fgpad-panel-outline--${side}`}
            viewBox={PANEL_VIEW_BOX}
            preserveAspectRatio="none"
            aria-hidden
        >
            <defs>
                <clipPath id={clipId}>
                    <path d={PANEL_OUTLINE_PATH} />
                </clipPath>
            </defs>
            <path
                className="fgpad-panel-glow"
                d={PANEL_OUTLINE_PATH}
                clipPath={`url(#${clipId})`}
            />
            <path className="fgpad-panel-stroke-outer" d={PANEL_OUTLINE_PATH} />
            <path
                className="fgpad-panel-stroke-inner"
                d={PANEL_OUTLINE_PATH}
                clipPath={`url(#${clipId})`}
            />
        </svg>
    );
};

interface FlyingGripperPadProps {
    onClose: () => void;
    sharedState?: SharedState;
}

const FlyingGripperPad: React.FC<FlyingGripperPadProps> = ({
    onClose,
    sharedState,
}) => {
    const robotIsHomed = sharedState?.robotIsHomed ?? true;
    const stretchTool = sharedState?.stretchTool;
    const motionDisabled = !robotIsHomed;
    const gripperDisabled =
        motionDisabled || stretchTool !== StretchTool.DW4;

    return (
        <div
            className="fgpad"
            style={RATIO_STYLE}
            role="group"
            aria-label="Flying gripper controls"
        >
            {/* Bottom row: two side panels carved around the ring + a standalone Close pill */}
            <PadButtonEl
                button={BAR_LEFT}
                className="fgpad-panel fgpad-panel--left"
                disabled={gripperDisabled}
            >
                <PanelOutline side="left" />
            </PadButtonEl>
            <button
                type="button"
                className="fgpad-close"
                onPointerDown={onClose}
                aria-label="Close flying gripper"
            >
                Close
            </button>
            <PadButtonEl
                button={BAR_RIGHT}
                className="fgpad-panel fgpad-panel--right"
                disabled={gripperDisabled}
            >
                <PanelOutline side="right" />
            </PadButtonEl>

            {/* Ring: four annular quarter-sector wedges, built like DirectionalPad's
                .button-cardinal (quarter circle + clipPath removing the inner disc). */}
            <div className="fgpad-ring">
                <svg className="fgpad-mask" aria-hidden>
                    {/* Hit area: true annular sector (outer r=1, inner r=0.5 about
                        the wedge's origin corner) so taps stop at the ring arc
                        instead of spilling onto the Close pill. */}
                    <clipPath id="fgpad-clip-hit" clipPathUnits="objectBoundingBox">
                        <path d="M1,0 A1,1 0 0 1 0,1 L0,0.5 A0.5,0.5 0 0 0 0.5,0 Z" />
                    </clipPath>
                    {/* Visual: the d-pad's clip (square minus inner disc). Keeps the
                        square corner so the pressed outer glow can spill past the
                        arc like it does on DirectionalPad. */}
                    <clipPath id="fgpad-clip-shape" clipPathUnits="objectBoundingBox">
                        <path d="M1,1 H0 V0.5 C0.276,0.5,0.5,0.276,0.5,0 H1 V1" />
                    </clipPath>
                </svg>
                {/* Each wedge = interactive button (hit clip, holds the chevron) +
                    a non-interactive sibling shape (surface clip, borders, glow).
                    Separate elements so the button's tight clip cannot clip the
                    shape's glow; `:active + .fgpad-wedge-shape` styles the pair. */}
                {RING_BUTTONS.map((button) => (
                    <React.Fragment key={button.id}>
                        <PadButtonEl
                            button={button}
                            className={`fgpad-wedge fgpad-wedge--${button.id}`}
                            disabled={motionDisabled}
                        />
                        <span
                            className={`fgpad-wedge-shape fgpad-wedge--${button.id}`}
                            aria-hidden
                        />
                    </React.Fragment>
                ))}
            </div>

            <div className="fgpad-inner">
                {INNER_BUTTONS.map((button) => (
                    <PadButtonEl
                        key={button.id}
                        button={button}
                        className={`fgpad-inner-btn fgpad-inner-btn--${button.id}`}
                        disabled={motionDisabled}
                    />
                ))}
                <div className="fgpad-inner-line" aria-hidden />
            </div>
        </div>
    );
};

export default FlyingGripperPad;
