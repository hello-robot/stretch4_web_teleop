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
    | "manual"
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
    manualLaunch: boolean,
): Treatment => {
    if (
        manualLaunch &&
        (status === "launching" ||
            status === "online" ||
            (status === "occupied" && heldByMe))
    ) {
        return "manual";
    }
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
    /** Logs were opened, so this launch waits for an explicit Launch click. */
    manualLaunch: boolean;
    /** Log modal is open, so the LOGS control is already satisfied. */
    logsOpen: boolean;
    onOpenLogs: () => void;
    onLaunch: () => void;
    onStop: () => void | Promise<void>;
}

export const TeleopButton = ({
    status,
    operatorHref,
    seat,
    beat,
    beatUntil,
    manualLaunch,
    logsOpen,
    onOpenLogs,
    onLaunch,
    onStop,
}: TeleopButtonProps) => {
    useEffect(() => {
        if (manualLaunch) return;
        if (status !== "online" || beatUntil <= Date.now()) return;
        const timer = window.setTimeout(() => {
            window.location.assign(operatorHref);
        }, beatUntil - Date.now());
        return () => window.clearTimeout(timer);
    }, [beatUntil, manualLaunch, operatorHref, status]);

    const visitorUid = loginHandler.getUserUid();
    const heldByMe = holdsOperatorSeat(seat, visitorUid);
    const treatment = treatmentFor(
        status,
        seat,
        Boolean(visitorUid),
        heldByMe,
        beat,
        manualLaunch,
    );
    const [elapsedSec, elapsedSecSet] = useState(0);
    const [ending, endingSet] = useState(false);
    const shown =
        ending && (treatment === "starting" || treatment === "end" || treatment === "manual")
            ? "ending"
            : treatment;
    const logsAvailable =
        !logsOpen &&
        (treatment === "starting" || treatment === "launching" || treatment === "manual");
    const launchReady = status === "online" || status === "occupied";

    useEffect(() => {
        if (treatment !== "starting" && treatment !== "end" && treatment !== "manual") {
            endingSet(false);
        }
    }, [treatment]);

    const stop = () => {
        if (ending) return;
        if (treatment === "starting" || treatment === "end" || treatment === "manual") {
            endingSet(true);
        }
        void Promise.resolve(onStop()).catch(() => endingSet(false));
    };

    const timing = treatment === "starting" || (treatment === "manual" && !launchReady);
    useEffect(() => {
        if (!timing) {
            elapsedSecSet(0);
            return;
        }
        const origin = Date.now();
        const timer = window.setInterval(() => {
            elapsedSecSet(Math.floor((Date.now() - origin) / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [timing]);

    return (
        <div className="hr-teleop">
            {!logsOpen && (
                <div className="hr-teleop__logs" aria-hidden={!logsAvailable}>
                    <button
                        type="button"
                        className={`hr-button__logs${logsAvailable ? " hr-button__logs--in" : ""}`}
                        onClick={onOpenLogs}
                        tabIndex={logsAvailable ? 0 : -1}
                    >
                        LOGS
                    </button>
                </div>
            )}
            {controlFor(
                shown,
                formatElapsed(elapsedSec),
                onLaunch,
                stop,
                () => window.location.assign(operatorHref),
                launchReady,
            )}
        </div>
    );
};

const controlFor = (
    treatment: Treatment,
    elapsed: string,
    onLaunch: () => void,
    onStop: () => void,
    onEnter: () => void,
    launchReady: boolean,
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
    if (treatment === "manual") {
        if (launchReady) {
            return (
                <button className="hr-button hr-button--primary" type="button" onClick={onEnter}>
                    Launch
                </button>
            );
        }
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
