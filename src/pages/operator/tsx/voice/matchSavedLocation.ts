/**
 * Pure helpers for voice load_autonav_location:
 * fuzzy match spoken labels against saved pose names.
 */

import { normalizePhrase } from "./phraseUtils";

export type MatchSavedLocationResult =
    | { kind: "unique"; name: string }
    | { kind: "none" }
    | { kind: "ambiguous" };

/**
 * Fuzzy-match a spoken label against saved pose names.
 * Requires exactly one candidate (exact, then substring / token containment).
 */
export function matchSavedLocation(
    label: string,
    poseNames: readonly string[],
): MatchSavedLocationResult {
    const spoken = normalizePhrase(label);
    if (!spoken || poseNames.length === 0) {
        return { kind: "none" };
    }

    const exact = poseNames.filter(
        (name) => normalizePhrase(name) === spoken,
    );
    if (exact.length === 1) {
        return { kind: "unique", name: exact[0] };
    }
    if (exact.length > 1) {
        return { kind: "ambiguous" };
    }

    const spokenTokens = new Set(spoken.split(" ").filter(Boolean));
    const fuzzy = poseNames.filter((name) => {
        const normalizedName = normalizePhrase(name);
        if (!normalizedName) {
            return false;
        }
        if (
            normalizedName.includes(spoken) ||
            spoken.includes(normalizedName)
        ) {
            return true;
        }
        const nameTokens = normalizedName.split(" ").filter(Boolean);
        if (spokenTokens.size === 0 || nameTokens.length === 0) {
            return false;
        }
        // All spoken tokens appear in the saved name (order-independent).
        return [...spokenTokens].every((token) =>
            nameTokens.some(
                (nameToken) =>
                    nameToken === token ||
                    nameToken.includes(token) ||
                    token.includes(nameToken),
            ),
        );
    });

    if (fuzzy.length === 1) {
        return { kind: "unique", name: fuzzy[0] };
    }
    if (fuzzy.length > 1) {
        return { kind: "ambiguous" };
    }
    return { kind: "none" };
}
