import React, { useRef } from "react";

import "operator/css/GoalHeadingClock.css";

/** Spoken names, clockwise from up. Index 0 is direction 1. */
const FACING_NAMES = [
    "Facing up",
    "Facing up and right",
    "Facing right",
    "Facing down and right",
    "Facing down",
    "Facing down and left",
    "Facing left",
    "Facing up and left",
];
const STEP_RAD = (2 * Math.PI) / FACING_NAMES.length;
/** Dial diameter. The hole leaves the canvas goal arrow visible in the center. */
const CLOCK_SIZE_PX = 170;
const HOLE_SIZE_PX = 80;
/** Inner edge of a wedge, as a percentage of the dial box. */
const INNER_RADIUS_PCT = (HOLE_SIZE_PX / 2 / CLOCK_SIZE_PX) * 100;
/** Full angular gap between wedges, in degrees. Split across the two edges. */
const WEDGE_GAP_DEG = 2;
const ARC_STEPS = 6;

const KEY_STEP: Record<string, number> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
};

type DialPoint = { x: number; y: number };

/** Point on the dial. 0° is up, and degrees increase clockwise. Percent of the dial box. */
function dialPoint(deg: number, radiusPct: number): DialPoint {
    const rad = (deg * Math.PI) / 180;
    return {
        x: 50 + radiusPct * Math.sin(rad),
        y: 50 - radiusPct * Math.cos(rad),
    };
}

type WedgeFace = {
    /** Clip in the hit target's own box. */
    clipPath: string;
    left: string;
    top: string;
    width: string;
    height: string;
};

/** Full-sector tap target. Voice Control does not number this layer. */
function wedgeFace(index: number, count: number): WedgeFace {
    const span = 360 / count;
    const midDeg = index * span;
    const start = midDeg - span / 2 + WEDGE_GAP_DEG / 2;
    const end = midDeg + span / 2 - WEDGE_GAP_DEG / 2;
    const points: DialPoint[] = [];
    for (let step = 0; step <= ARC_STEPS; step++) {
        const deg = start + ((end - start) * step) / ARC_STEPS;
        points.push(dialPoint(deg, 50));
    }
    for (let step = ARC_STEPS; step >= 0; step--) {
        const deg = start + ((end - start) * step) / ARC_STEPS;
        points.push(dialPoint(deg, INNER_RADIUS_PCT));
    }
    const midRadius = (INNER_RADIUS_PCT + 50) / 2;
    const center = dialPoint(midDeg, midRadius);
    const halfWidth = Math.max(...points.map((point) => Math.abs(point.x - center.x)));
    const halfHeight = Math.max(...points.map((point) => Math.abs(point.y - center.y)));
    const left = center.x - halfWidth;
    const top = center.y - halfHeight;
    const width = halfWidth * 2;
    const height = halfHeight * 2;
    const clip = points.map(
        (point) =>
            `${(((point.x - left) / width) * 100).toFixed(3)}% ${(((point.y - top) / height) * 100).toFixed(3)}%`,
    );
    return {
        clipPath: `polygon(${clip.join(", ")})`,
        left: `${left.toFixed(3)}%`,
        top: `${top.toFixed(3)}%`,
        width: `${width.toFixed(3)}%`,
        height: `${height.toFixed(3)}%`,
    };
}

const WEDGE_FACES = FACING_NAMES.map((_, index) => wedgeFace(index, FACING_NAMES.length));

/**
 * Where Voice Control draws its number: the button's own box, inset so the
 * badge — which iOS hangs off the top-left — still sits on the wedge.
 * Percents of the dial. The full sector stays tappable via the hit layer.
 * Tuned for the 170px dial / 80px hole above.
 */
const BUTTON_FRAMES = [
    { left: "41%", top: "9%", width: "18%", height: "18%" },
    { left: "72%", top: "19%", width: "17%", height: "14%" },
    { left: "81%", top: "46%", width: "17%", height: "16%" },
    { left: "67%", top: "77%", width: "14%", height: "12%" },
    { left: "46%", top: "81%", width: "16%", height: "17%" },
    { left: "19%", top: "72%", width: "14%", height: "17%" },
    { left: "9%", top: "41%", width: "18%", height: "18%" },
    { left: "18%", top: "24%", width: "13%", height: "12%" },
];

/** Map-frame yaw (radians) for a direction number (1-8). */
export function directionToYaw(direction: number): number {
    return Math.PI / 2 - (direction - 1) * STEP_RAD;
}

/** Nearest direction number (1-8) to a map-frame yaw (radians). */
export function yawToDirection(yaw: number): number {
    const steps = Math.round((Math.PI / 2 - yaw) / STEP_RAD);
    const count = FACING_NAMES.length;
    return (((steps % count) + count) % count) + 1;
}

type GoalHeadingClockProps = {
    /** Current goal heading, map-frame yaw in radians. */
    yaw: number;
    /** Clock center in CSS px, relative to the positioned parent (the goal marker). */
    center: { x: number; y: number };
    onSelect: (yaw: number) => void;
};

/**
 * Dial drawn around the goal marker for choosing which way the robot faces at
 * the goal. Eight wedge buttons; the canvas arrow in the hole shows the heading.
 */
export function GoalHeadingClock({ yaw, center, onSelect }: GoalHeadingClockProps) {
    const selected = yawToDirection(yaw);
    const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

    function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const step = KEY_STEP[event.key];
        if (step === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        const count = FACING_NAMES.length;
        const next = ((selected - 1 + step) % count + count) % count + 1;
        buttonRefs.current[next - 1]?.focus();
        onSelect(directionToYaw(next));
    }

    return (
        <div
            className="goal-heading-clock"
            role="radiogroup"
            aria-label="Robot facing direction"
            style={{
                ["--clock-center-x" as string]: `${center.x}px`,
                ["--clock-center-y" as string]: `${center.y}px`,
                ["--clock-size" as string]: `${CLOCK_SIZE_PX}px`,
                ["--hole-size" as string]: `${HOLE_SIZE_PX}px`,
            }}
            onKeyDown={onKeyDown}
        >
            {FACING_NAMES.map((name, index) => {
                const direction = index + 1;
                const isSelected = direction === selected;
                const face = WEDGE_FACES[index];
                return (
                    <div
                        key={name}
                        className={
                            isSelected
                                ? "goal-heading-clock__wedge goal-heading-clock__wedge--selected"
                                : "goal-heading-clock__wedge"
                        }
                    >
                        <div
                            className="goal-heading-clock__hit"
                            aria-hidden="true"
                            style={{
                                left: face.left,
                                top: face.top,
                                width: face.width,
                                height: face.height,
                                clipPath: face.clipPath,
                            }}
                            onClick={() => onSelect(directionToYaw(direction))}
                        />
                        <button
                            ref={(node) => {
                                buttonRefs.current[index] = node;
                            }}
                            type="button"
                            role="radio"
                            className="goal-heading-clock__segment"
                            style={BUTTON_FRAMES[index]}
                            aria-checked={isSelected}
                            aria-label={name}
                            tabIndex={isSelected ? 0 : -1}
                            onClick={() => onSelect(directionToYaw(direction))}
                        >
                            <span className="goal-heading-clock__name">{name}</span>
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
