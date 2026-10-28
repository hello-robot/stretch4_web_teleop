/**  Some generic utils for working with Action Speed / Velocity */

import { PROFILE_SCALES, type SpeedProfile } from "shared/util";

export type ActionSpeedLabel = SpeedProfile;

export type ActionSpeedPreset = {
    label: ActionSpeedLabel;
    speed: number;
};

/**
 * The speed presets the UI offers, derived from PROFILE_SCALES so the value the interface stores
 * is the same multiplier the motion code applies. getLabelBySpeed() matches on exact equality, so
 * a preset that drifted from PROFILE_SCALES would resolve to no label and silently fall back to
 * the medium profile.
 */
export const VELOCITY_SCALE: ActionSpeedPreset[] = (
    ["slow", "medium", "fast"] as const
).map((label) => ({ label, speed: PROFILE_SCALES[label] }));

export const DEFAULT_VELOCITY_SCALE: number = VELOCITY_SCALE[1].speed;

export function getSpeedByLabel(label: string): number | undefined {
    return VELOCITY_SCALE.find((item) => item.label === label)?.speed;
}

export function getLabelBySpeed(speed: number): ActionSpeedLabel | undefined {
    return VELOCITY_SCALE.find((item) => item.speed === speed)?.label;
}

