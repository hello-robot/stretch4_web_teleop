import React, { useEffect, useState } from "react";
import { loginHandler } from "../index";
import {
    holdsOperatorSeat,
    OperatorSeat,
    RobotStatus,
} from "../robotModel";

type Treatment =
    | "offline"
    | "standby"
    | "starting"
    | "launching"
    | "pending"
    | "ending"
    | "end"
    | "in-use";

const treatmentFor = (
    status: RobotStatus,
    seat: OperatorSeat | null,
    visitorKnown: boolean,
    heldByMe: boolean,
    beat: boolean,
): Treatment => {
    if (status === "offline") return "offline";
    if (status === "standby") return "standby";
    if (status === "launching") return "starting";
    if (beat) return "launching";
    if ((status === "online" || status === "occupied") && seat && !heldByMe) return "in-use";
    if (status === "occupied" && !(seat && visitorKnown)) return "pending";
    if (status === "online" || status === "occupied") return "end";
    return "offline";
};

const formatElapsed = (totalSeconds: number): string => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

interface TeleopButtonProps {
    status: RobotStatus;
    operatorHref: string;
    seat: OperatorSeat | null;
    beat: boolean;
    beatUntil: number;
    onLaunch: () => void;
    onStop: () => void | Promise<void>;
}

export const TeleopButton = ({
    status,
    operatorHref,
    seat,
    beat,
    beatUntil,
    onLaunch,
    onStop,
}: TeleopButtonProps) => {
    useEffect(() => {
        if (status !== "online" || beatUntil <= Date.now()) return;
        const timer = window.setTimeout(() => {
            window.location.assign(operatorHref);
        }, beatUntil - Date.now());
        return () => window.clearTimeout(timer);
    }, [beatUntil, operatorHref, status]);

    const visitorUid = loginHandler.getUserUid();
    const heldByMe = holdsOperatorSeat(seat, visitorUid);
    const treatment = treatmentFor(status, seat, Boolean(visitorUid), heldByMe, beat);
    const [elapsedSec, elapsedSecSet] = useState(0);
    const [ending, endingSet] = useState(false);
    const shown =
        ending && (treatment === "starting" || treatment === "end") ? "ending" : treatment;

    useEffect(() => {
        if (treatment !== "starting" && treatment !== "end") endingSet(false);
    }, [treatment]);

    const stop = () => {
        if (ending) return;
        if (treatment === "starting" || treatment === "end") endingSet(true);
        void Promise.resolve(onStop()).catch(() => endingSet(false));
    };

    useEffect(() => {
        if (treatment !== "starting") {
            elapsedSecSet(0);
            return;
        }
        const origin = Date.now();
        const timer = window.setInterval(() => {
            elapsedSecSet(Math.floor((Date.now() - origin) / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [treatment]);

    return (
        <div className="hr-teleop">
            <div className="hr-teleop__logs" aria-hidden={treatment !== "starting"}>
                <span className={`hr-button__logs${treatment === "starting" ? " hr-button__logs--in" : ""}`}>
                    LOGS
                </span>
            </div>
            {controlFor(shown, seat?.initials, formatElapsed(elapsedSec), onLaunch, stop)}
        </div>
    );
};

const controlFor = (
    treatment: Treatment,
    initials: string | undefined,
    elapsed: string,
    onLaunch: () => void,
    onStop: () => void,
) => {
    if (treatment === "standby") {
        return (
            <button className="hr-button hr-button--primary" type="button" onClick={onLaunch}>
                Teleoperate
            </button>
        );
    }
    if (treatment === "pending") {
        return (
            <div
                className="hr-button hr-button--skeleton"
                role="status"
                aria-label="Checking who is operating"
            />
        );
    }
    if (treatment === "ending") {
        return (
            <button
                className="hr-button hr-button--dim hr-button--progress"
                type="button"
                disabled
                aria-label="Ending"
            >
                <span className="hr-button__face">
                    <span className="hr-button__starting">
                        Ending
                        <span className="hr-button__ellipsis" aria-hidden="true" />
                    </span>
                </span>
            </button>
        );
    }
    if (treatment === "end") {
        return (
            <button className="hr-button hr-button--ghost" type="button" onClick={onStop}>
                End Teleoperation
            </button>
        );
    }
    if (treatment === "starting") {
        return (
            <button
                className="hr-button hr-button--dim hr-button--progress"
                type="button"
                onClick={onStop}
                aria-label={`Starting, ${elapsed}. Activate to abort.`}
            >
                <span className="hr-button__face">
                    <span className="hr-button__elapsed">{elapsed}</span>
                    <span className="hr-button__starting">
                        Starting
                        <span className="hr-button__ellipsis" aria-hidden="true" />
                    </span>
                </span>
            </button>
        );
    }
    if (treatment === "launching") {
        return (
            <button className="hr-button hr-button--dim hr-button--progress" type="button" disabled>
                <span className="hr-button__face">
                    Launching
                    <span className="hr-button__countdown" aria-hidden="true" />
                </span>
            </button>
        );
    }
    if (treatment === "in-use") {
        return (
            <div
                className="hr-button hr-button--dim hr-button--progress"
                role="status"
                aria-label="Currently in Use"
            >
                <span className="hr-button__face">
                    <span className="hr-button__mark" aria-hidden="true">
                        {initials || ""}
                    </span>
                    Currently in Use
                </span>
            </div>
        );
    }
    return (
        <button className="hr-button hr-button--dim" type="button" disabled>
            Teleoperate
        </button>
    );
};
