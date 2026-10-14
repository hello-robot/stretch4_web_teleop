import React, { useEffect, useRef, useState } from "react";
import { markOperatorTakeover } from "shared/signaling/operatorSeat";
import { gravatarUrl } from "../gravatar";
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
    | "failed"
    | "connect"
    | "takeover"
    | "in-use";

const launchOwnerKey = (operatorHref: string) => `hr-launch-owner:${operatorHref}`;

/** Controls that tear the interface down, and so swap to Ending while it happens. */
const STOPPABLE: Treatment[] = [
    "starting",
    "manual",
    "in-use",
    "connect",
    "takeover",
];
const canStop = (treatment: Treatment) => STOPPABLE.includes(treatment);

const treatmentFor = (
    status: RobotStatus,
    seat: OperatorSeat | null,
    visitorKnown: boolean,
    heldByMe: boolean,
    beat: boolean,
    manualLaunch: boolean,
    launchedHere: boolean,
    launchFailed: boolean,
    restarting: boolean,
): Treatment => {
    // Manual mode exists to hold the tab back during a launch it is watching.
    // Once the interface is up, the ordinary Connect + Stop pair is correct:
    // the auto-navigate stays suppressed by the manualLaunch state itself, not
    // by this treatment, so falling through does not drag the user into teleop.
    if (manualLaunch && status === "launching") {
        return "manual";
    }
    if (status === "offline") return "offline";
    if (launchFailed) return "failed";

    // A restart this tab drove is one continuous launch from the user's view,
    // so it has to claim the treatment before the status-based branches below.
    // The daemon still reports the old status for as long as it takes to
    // receive the stop and tear down, and it passes back through standby on
    // the way to launching: without this the card would offer Connect, then
    // Start Interface, then finally animate.
    if (restarting) return "starting";

    if (status === "standby") return "standby";

    // Someone else is driving. Their session can't be joined, so stopping the
    // interface is the only way in.
    if ((status === "online" || status === "occupied") && seat && !heldByMe) {
        return "in-use";
    }
    if (status === "occupied" && !(seat && visitorKnown)) return "pending";

    // A launch in flight: the tab that asked for it watches progress and can
    // abort; everyone else can queue up behind it.
    if (status === "launching") return launchedHere ? "starting" : "takeover";
    if (beat) return launchedHere ? "launching" : "takeover";

    // Interface up and free to us. Reclaiming our own seat needs the takeover
    // flag; an empty seat does not. Either way the pair is Connect + Stop,
    // whether or not this tab is the one that launched it.
    if (status === "online" || status === "occupied") {
        return heldByMe ? "takeover" : "connect";
    }
    return "offline";
};

/** Who is driving, beside the Stop label so the photo spans both lines. */
const OccupantNote = ({ email }: { email?: string }) => {
    const [photo, photoSet] = useState<string | null>(null);
    const [photoReady, photoReadySet] = useState(false);

    useEffect(() => {
        photoSet(null);
        photoReadySet(false);
        if (!email) return;
        let cancelled = false;
        gravatarUrl(email, 64).then((url) => {
            if (!cancelled) photoSet(url);
        });
        return () => {
            cancelled = true;
        };
    }, [email]);

    return (
        <span className="hr-button__occupant">
            {photo ? (
                <img
                    className="hr-teleop__note-photo"
                    alt=""
                    src={photo}
                    hidden={!photoReady}
                    onLoad={() => photoReadySet(true)}
                    onError={() => {
                        photoSet(null);
                        photoReadySet(false);
                    }}
                />
            ) : null}
            <span className="hr-button__stack">
                <span>Stop Interface</span>
                <span className="hr-teleop__note-text">
                    {email ? `In use by ${email}` : "In use by another operator"}
                </span>
            </span>
        </span>
    );
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
    /**
     * A relaunch this tab asked for from a settings sheet is in flight. It
     * reads as a local launch so the card animates, but deliberately does not
     * feed the auto-navigate below: applying settings is not a request to be
     * dropped into teleop.
     */
    restarting: boolean;
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
    restarting,
    onOpenLogs,
    onLaunch,
    onStop,
}: TeleopButtonProps) => {
    const ownerKey = launchOwnerKey(operatorHref);
    const [launchedHere, launchedHereSet] = useState(
        () => sessionStorage.getItem(ownerKey) === "1",
    );
    useEffect(() => {
        if (status !== "standby" && status !== "offline") return;
        sessionStorage.removeItem(ownerKey);
        launchedHereSet(false);
    }, [ownerKey, status]);
    useEffect(() => {
        if (!launchedHere || manualLaunch) return;
        if (status !== "online" || beatUntil <= Date.now()) return;
        const timer = window.setTimeout(() => {
            window.location.assign(operatorHref);
        }, Math.max(0, beatUntil - Date.now()));
        return () => window.clearTimeout(timer);
    }, [beatUntil, launchedHere, manualLaunch, operatorHref, status]);

    /**
     * The daemon reports a failed launch by dropping back to standby without
     * ever reaching online, and leaves its output in launch_logs for the LOGS
     * panel. Only the tab that asked for the launch is told: a bystander
     * watching someone else abort a launch hasn't had anything fail.
     */
    const [launchFailed, launchFailedSet] = useState(false);
    const sawLaunching = useRef(false);
    const launchedByMe = useRef(launchedHere);
    useEffect(() => {
        if (restarting) launchedByMe.current = true;
    }, [restarting]);

    useEffect(() => {
        if (status === "launching") {
            sawLaunching.current = true;
            launchFailedSet(false);
            return;
        }
        if (status === "online" || status === "occupied") {
            sawLaunching.current = false;
            launchFailedSet(false);
            return;
        }
        // Only standby — daemon up, interface gone — reads as a failed launch.
        // An unreachable robot is already reported by the Offline pill, and
        // retrying there cannot work, so drop the notice instead of raising it.
        if (status === "offline") {
            launchFailedSet(false);
        } else if (sawLaunching.current && launchedByMe.current) {
            launchFailedSet(true);
        }
        sawLaunching.current = false;
    }, [status]);

    const visitorUid = loginHandler.getUserUid();
    const heldByMe = holdsOperatorSeat(seat, visitorUid);
    const treatment = treatmentFor(
        status,
        seat,
        Boolean(visitorUid),
        heldByMe,
        beat,
        manualLaunch,
        launchedHere,
        launchFailed,
        restarting,
    );
    const [elapsedSec, elapsedSecSet] = useState(0);
    const [ending, endingSet] = useState(false);
    const shown = ending && canStop(treatment) ? "ending" : treatment;
    const logsAvailable =
        !logsOpen &&
        (treatment === "starting" ||
            treatment === "launching" ||
            treatment === "manual" ||
            treatment === "failed" ||
            manualLaunch);
    const launchReady = status === "online" || status === "occupied";

    useEffect(() => {
        if (!canStop(treatment)) endingSet(false);
    }, [treatment]);

    const stop = () => {
        if (ending) return;
        launchedByMe.current = false;
        if (canStop(treatment)) endingSet(true);
        void Promise.resolve(onStop()).catch(() => endingSet(false));
    };

    const launch = () => {
        sessionStorage.setItem(ownerKey, "1");
        launchedHereSet(true);
        launchedByMe.current = true;
        launchFailedSet(false);
        onLaunch();
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
                launch,
                stop,
                () => window.location.assign(operatorHref),
                () => {
                    markOperatorTakeover();
                    window.location.assign(operatorHref);
                },
                launchReady,
                seat?.email,
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
    onTakeover: () => void,
    launchReady: boolean,
    occupantEmail?: string,
) => {
    if (treatment === "standby") {
        return (
            <button className="hr-button hr-button--primary" type="button" onClick={onLaunch}>
                Start Interface
            </button>
        );
    }
    if (treatment === "failed") {
        return (
            <button className="hr-button hr-button--primary" type="button" onClick={onLaunch}>
                <span className="hr-button__stack">
                    <span>Start Interface</span>
                    <span className="hr-teleop__note hr-teleop__note--fail">
                        Launch failed &mdash; check LOGS
                    </span>
                </span>
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
    if (treatment === "manual") {
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
    // `takeover` is our own seat, or one being launched: claim it rather than
    // relaunching. `connect` is a free seat on a running interface.
    if (treatment === "connect" || treatment === "takeover") {
        return (
            <>
                <button
                    className="hr-button hr-button--primary"
                    type="button"
                    onClick={treatment === "connect" ? onEnter : onTakeover}
                >
                    Connect
                </button>
                {launchReady && (
                    <button
                        className="hr-button hr-button--ghost"
                        type="button"
                        onClick={onStop}
                    >
                        Stop Interface
                    </button>
                )}
            </>
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
            <button className="hr-button hr-button--ghost" type="button" onClick={onStop}>
                <OccupantNote email={occupantEmail} />
            </button>
        );
    }
    return (
        <button className="hr-button hr-button--dim" type="button" disabled>
            Start Interface
        </button>
    );
};
