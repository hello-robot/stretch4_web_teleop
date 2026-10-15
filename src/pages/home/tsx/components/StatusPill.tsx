import dotBusy from "home/public/icons/dot-busy.svg";
import dotIdle from "home/public/icons/dot-idle.svg";
import dotOffline from "home/public/icons/dot-offline.svg";
import dotReady from "home/public/icons/dot-ready.svg";
import React from "react";
import { RobotPresence } from "../robotModel";

type PillSpec = { label: string; dot: string; dotClass: string; textClass: string };

const PILLS: Record<RobotPresence, PillSpec> = {
    offline: {
        label: "Offline",
        dot: dotOffline,
        dotClass: "hr-pill__dot-flat",
        textClass: "hr-pill__text--muted",
    },
    idle: {
        label: "Idle",
        dot: dotIdle,
        dotClass: "hr-pill__dot-flat",
        textClass: "hr-pill__text--idle",
    },
    ready: {
        label: "Ready",
        dot: dotReady,
        dotClass: "hr-pill__dot-glow",
        textClass: "hr-pill__text--ready",
    },
    "in-use": {
        label: "In Use",
        dot: dotBusy,
        dotClass: "hr-pill__dot-glow",
        textClass: "hr-pill__text--busy",
    },
};

export const StatusPill = ({ presence }: { presence: RobotPresence }) => {
    const spec = PILLS[presence];
    return (
        <div className="hr-pill">
            <span className="hr-pill__dot">
                <img alt="" className={spec.dotClass} src={spec.dot} />
            </span>
            <span className={`hr-pill__text ${spec.textClass}`}>{spec.label}</span>
        </div>
    );
};
