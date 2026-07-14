/**
 * Normalize output from STT (English-only for now)
 *
 * "Hello, Stretch!" → "hello stretch"
 * "Bye-bye robot." → "bye bye robot"
*/
export function normalizePhrase(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}