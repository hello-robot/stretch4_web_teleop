/**
 * iPhone, iPod, and iPad, including iPadOS 13+ which reports as MacIntel.
 */
export function isIosLike(): boolean {
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) {
        return true;
    }
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
