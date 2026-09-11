/**
 * Pure helpers for voice load_autonav_location:
 * required "Navigate to …" / "Navigate to the …" prefix + fuzzy match against saved pose names.
 */

import { normalizePhrase } from "./phraseUtils";

/**
 * Normalized prefixes that mean "Navigate to [the]" (STT variants).
 * Longer forms first so "Navigate to the office" yields label "office", not "the office".
 */
const NAVIGATE_TO_PREFIXES = [
    "navigate to the",
    "navigated to the",
    "navigate to",
    "navigated to",
] as const;

/** Bare navigate tokens (no place) — may be split from a following "to …". */
const BARE_NAVIGATE_PHRASES = new Set(["navigate", "navigated"]);

export type MatchSavedLocationResult =
    | { kind: "unique"; name: string }
    | { kind: "none" }
    | { kind: "ambiguous" };

/**
 * True when the transcript contains a required "Navigate to [the]" prefix
 * (including common STT mishearings).
 */
export function hasNavigateToThePrefix(transcript: string): boolean {
    const normalized = normalizePhrase(transcript);
    if (!normalized) {
        return false;
    }
    return NAVIGATE_TO_PREFIXES.some((prefix) =>
        normalized.includes(prefix),
    );
}

/**
 * Extract the place name after "Navigate to [the]" (STT variants).
 * @returns trimmed label, or null when prefix missing / no place given
 */
export function extractLabelAfterNavigateToThe(
    transcript: string,
): string | null {
    const normalized = normalizePhrase(transcript);
    if (!normalized) {
        return null;
    }
    for (const prefix of NAVIGATE_TO_PREFIXES) {
        const idx = normalized.indexOf(prefix);
        if (idx < 0) {
            continue;
        }
        const label = normalized.slice(idx + prefix.length).trim();
        return label.length > 0 ? label : null;
    }
    return null;
}

/**
 * True when the whole utterance is only a bare navigate word
 * (e.g. "Navigate", "navigated") with no "to …" place.
 */
export function isBareNavigatePhrase(transcript: string): boolean {
    const normalized = normalizePhrase(transcript);
    return BARE_NAVIGATE_PHRASES.has(normalized);
}

/**
 * True when a follow-up turn is only "to …" / "to the …"
 * (VAD split after bare Navigate).
 */
export function isToThePlaceContinuation(transcript: string): boolean {
    const normalized = normalizePhrase(transcript);
    if (!normalized.startsWith("to ")) {
        return false;
    }
    const afterTo = normalized.slice("to ".length).trim();
    return afterTo.length > 0 && afterTo !== "the";
}

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
