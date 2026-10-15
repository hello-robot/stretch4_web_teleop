import { useEffect, useRef, useState } from "react";
import { RobotStatus } from "./robotModel";

/** How long the "Launching" countdown stays up after the app reports online. */
export const LAUNCHING_BEAT_MS = 3000;

/** True for LAUNCHING_BEAT_MS after status moves from launching to online. */
export const useLaunchingBeat = (status: RobotStatus) => {
    const [beatUntil, beatUntilSet] = useState(0);
    const [now, nowSet] = useState(() => Date.now());
    const prevStatus = useRef(status);
    if (prevStatus.current === "launching" && status === "online") {
        prevStatus.current = status;
        beatUntilSet(Date.now() + LAUNCHING_BEAT_MS);
    } else if (prevStatus.current !== status) {
        prevStatus.current = status;
    }

    useEffect(() => {
        if (beatUntil <= Date.now()) return;
        const timer = window.setTimeout(() => nowSet(Date.now()), beatUntil - Date.now());
        return () => window.clearTimeout(timer);
    }, [beatUntil]);

    const beat = status === "online" && now < beatUntil;
    return { beat, beatUntil };
};
