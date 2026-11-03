/**
 * Voice tool executor for `save_map_location`.
 * Saves the robot's current map pose under a user-provided label via SaveGoal.
 */

import { underMapFunctionProvider } from "..";
import { UnderMapButton } from "../function_providers/UnderMapFunctionProvider";
import type { ExecuteToolResult } from "./constants";

export type SaveMapLocationResult = {
    ok: boolean;
    label?: string;
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
 * Save the current map pose under `label` using UnderMap SaveGoal.
 */
export function executeSaveMapLocation(
    raw: Record<string, unknown>,
): ExecuteToolResult & { label?: string } {
    const label = parseSaveMapLocationLabel(raw);
    if (!label) {
        return {
            ok: false,
            detail: "Missing location label.",
            ignored: true,
        };
    }

    if (!underMapFunctionProvider) {
        return {
            ok: false,
            detail: "Map location saving is unavailable.",
            ignored: true,
            label,
        };
    }

    try {
        const saveGoal = underMapFunctionProvider.provideFunctions(
            UnderMapButton.SaveGoal,
        ) as (name: string) => void;
        saveGoal(label);
        return {
            ok: true,
            detail: `Location "${label}" added.`,
            label,
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const detail =
            msg.includes("undefined map pose") || msg.includes("Cannot save")
                ? "Cannot save location — map pose unavailable."
                : `Failed to save location: ${msg}`;
        return {
            ok: false,
            detail,
            label,
        };
    }
}
