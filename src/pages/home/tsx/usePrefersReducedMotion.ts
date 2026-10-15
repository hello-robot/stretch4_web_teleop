import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export const usePrefersReducedMotion = () => {
    const [reduced, reducedSet] = useState(
        () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
    );

    useEffect(() => {
        const media = window.matchMedia(QUERY);
        const onChange = () => reducedSet(media.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);

    return reduced;
};
