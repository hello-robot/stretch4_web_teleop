import dotOffline from "home/public/icons/dot-offline.svg";
import dotOnline from "home/public/icons/dot-online.svg";
import React from "react";
import { RobotStatus } from "../robotModel";

type PillSpec = { label: string; dot: "glow" | "flat"; textClass: string };

const ONLINE: PillSpec = { label: "Online", dot: "glow", textClass: "hr-pill__text--gradient" };
const OFFLINE: PillSpec = { label: "Offline", dot: "flat", textClass: "hr-pill__text--muted" };

const PILLS: Record<RobotStatus, PillSpec> = {
    online: ONLINE,
    standby: ONLINE,
    launching: ONLINE,
    occupied: ONLINE,
    offline: OFFLINE,
};

export const StatusPill = ({ status }: { status: RobotStatus }) => {
    const spec = PILLS[status];
    return (
        <div className="hr-pill">
            <span className="hr-pill__dot">
                {spec.dot === "glow" ? (
                    <img alt="" className="hr-pill__dot-glow" src={dotOnline} />
                ) : (
                    <img alt="" className="hr-pill__dot-flat" src={dotOffline} />
                )}
            </span>
            <span className={`hr-pill__text ${spec.textClass}`}>{spec.label}</span>
        </div>
    );
};
