/**  Some generic utils for working with Action Speed / Velocity */

export type ActionSpeedLabel = "slow" | "medium" | "fast";

export type ActionSpeedPreset = {
    label: ActionSpeedLabel;
    speed: number;
};

export const VELOCITY_SCALE: ActionSpeedPreset[] = [
    { label: "slow", speed: 0.75 },
    { label: "medium", speed: 1.25 },
    { label: "fast", speed: 2.0 },
];

export const DEFAULT_VELOCITY_SCALE: number = VELOCITY_SCALE[1].speed;

export function getSpeedByLabel(label: string): number | undefined {
    return VELOCITY_SCALE.find((item) => item.label === label)?.speed;
}

export function getLabelBySpeed(speed: number): string | undefined {
    return VELOCITY_SCALE.find((item) => item.speed === speed)?.label;
}

/** Voice `execute_base_move.speed` → UI velocity scale value. */
export function velocityScaleForVoiceSpeed(
    speed: ActionSpeedLabel,
): number {
    return getSpeedByLabel(speed) ?? DEFAULT_VELOCITY_SCALE;
}
