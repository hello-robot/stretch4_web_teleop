import React, { useId } from "react";

import "operator/css/GoalHeadingClock.css";

/** Directions clockwise from up on the map, 45 degrees apart; 1 is up. */
const DIRECTIONS = [
    "up",
    "up-right",
    "right",
    "down-right",
    "down",
    "down-left",
    "left",
    "up-left",
];
const STEP_RAD = (2 * Math.PI) / DIRECTIONS.length;

/** Map-frame yaw (radians) for a direction number (1-8). */
export function directionToYaw(direction: number): number {
    return Math.PI / 2 - (direction - 1) * STEP_RAD;
}

/** Nearest direction number (1-8) to a map-frame yaw (radians). */
export function yawToDirection(yaw: number): number {
    const steps = Math.round((Math.PI / 2 - yaw) / STEP_RAD);
    const count = DIRECTIONS.length;
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
 * the goal.
 */
export function GoalHeadingClock({ yaw, center, onSelect }: GoalHeadingClockProps) {
    const name = `goal-heading-${useId().replace(/:/g, "")}`;
    const selected = yawToDirection(yaw);

    return (
        <fieldset
            className="goal-heading-clock"
            style={{
                ["--clock-center-x" as string]: `${center.x}px`,
                ["--clock-center-y" as string]: `${center.y}px`,
            }}
        >
            <legend className="goal-heading-clock__sr-only">Robot facing direction</legend>
            {DIRECTIONS.map((label, i) => {
                const direction = i + 1;
                return (
                    <label
                        key={direction}
                        className="goal-heading-clock__hour"
                        style={{
                            ["--hour-angle" as string]: `${i * (360 / DIRECTIONS.length)}deg`,
                        }}
                    >
                        <input
                            type="radio"
                            name={name}
                            value={direction}
                            checked={direction === selected}
                            onChange={() => onSelect(directionToYaw(direction))}
                        />
                        <span>
                            {direction}
                            <span className="goal-heading-clock__sr-only">, facing {label}</span>
                        </span>
                    </label>
                );
            })}
        </fieldset>
    );
}
