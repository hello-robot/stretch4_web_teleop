/**
 * Voice tool executor for `save_map_location`.
 * Saves the tapped destination, or the robot's current pose when none is tapped.
 */

import type { ExecuteToolResult } from "./constants";

export type SaveMapLocationResult = {
    ok: boolean;
    label?: string;
    detail: string;
};

/** Saves the active AutoNav place. Provided by AutoNav; absent when AutoNav is not mounted. */
export type SaveSelectedGoal = (label: string) => {
    ok: boolean;
    detail: string;
};

/**
 * Parse and trim the label from Realtime tool arguments.
 * @returns trimmed label, or empty string when missing/invalid
 */
export function parseSaveMapLocationLabel(
    raw: Record<string, unknown>,
): string {
    if (typeof raw.label !== "string") {
        return "";
    }
    return raw.label.trim();
}

/**
 * Save the tapped destination, or the robot pose when none is tapped.
 */
export function executeSaveMapLocation(
    raw: Record<string, unknown>,
    saveSelectedGoal?: SaveSelectedGoal,
): ExecuteToolResult & { label?: string } {
    const label = parseSaveMapLocationLabel(raw);
    if (!label) {
        return {
            ok: false,
            detail: "Missing location label.",
            ignored: true,
        };
    }

    if (!saveSelectedGoal) {
        return {
            ok: false,
            detail: "Map location saving is unavailable.",
            ignored: true,
            label,
        };
    }

    const result = saveSelectedGoal(label);
    return result.ok
        ? { ok: true, detail: result.detail, label }
        : { ok: false, detail: result.detail, ignored: true, label };
}
