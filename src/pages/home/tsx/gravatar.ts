/**
 * Gravatar lookups. Gravatar hashes the trimmed, lower-cased email with
 * SHA-256; `d=404` makes unknown addresses fail the <img> load so callers can
 * fall back instead of showing Gravatar's default placeholder.
 */

const toHex = (bytes: ArrayBuffer): string =>
    Array.from(new Uint8Array(bytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export async function gravatarUrl(email: string, sizePx: number): Promise<string> {
    const data = new TextEncoder().encode(normalizeEmail(email));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return `https://gravatar.com/avatar/${toHex(digest)}?s=${sizePx}&d=404`;
}

/** `jane.doe@example.com` -> `JD`; single-word locals yield one letter. */
export const emailInitials = (email: string): string =>
    initialsFromName(normalizeEmail(email).split("@")[0]);

/** `hello-william` -> `HW`. */
export const aliasInitials = (alias: string): string => initialsFromName(alias);

const initialsFromName = (name: string): string =>
    name
        .split(/[._\-+]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
