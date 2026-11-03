import dotBusy from "home/public/icons/dot-busy.svg";
import dotIdle from "home/public/icons/dot-idle.svg";
import dotOffline from "home/public/icons/dot-offline.svg";
import dotReady from "home/public/icons/dot-ready.svg";
import powerMark from "home/public/icons/power.svg";
import React, { useLayoutEffect, useRef, useState } from "react";
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

/** Ready and Idle can arm a shutdown control. Offline and In Use stay status chips. */
export type PillPhase = "status" | "shutdown" | "shutting-down";

const PRESENCE_ORDER: RobotPresence[] = ["offline", "idle", "ready", "in-use"];

type FaceId = RobotPresence | Exclude<PillPhase, "status">;

const FACE_IDS: FaceId[] = [...PRESENCE_ORDER, "shutdown", "shutting-down"];

const ACTION_COPY: Record<
    Exclude<PillPhase, "status">,
    { label: string; icon?: string }
> = {
    shutdown: { label: "Shutdown", icon: powerMark },
    "shutting-down": { label: "Shutting down" },
};

/** Caps are 35px circles. The middle stretches between their centers. */
const CAP_PX = 35;

const px = (value: number) => `${value}px`;

const widthsEqual = (a: Record<string, number>, b: Record<string, number>) => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => a[key] === b[key]);
};

const chromeVars = (width: number, max: number): React.CSSProperties => {
    const span = Math.max(max - CAP_PX, 1);
    const scale = Math.max(0, (width - CAP_PX) / span);
    return {
        ["--pill-shift" as string]: px(-(Math.max(width, CAP_PX) - CAP_PX)),
        ["--pill-scale" as string]: String(scale),
    };
};

const PillChrome = ({
    kind,
    width,
    max,
    on,
}: {
    kind: "line" | "fill";
    width: number;
    max: number;
    on: boolean;
}) => (
    <span
        aria-hidden
        className={`hr-pill__chrome hr-pill__chrome--${kind}${on ? " is-on" : ""}`}
        style={chromeVars(width, max)}
    >
        <span className="hr-pill__mid" style={{ width: px(Math.max(max - CAP_PX, 0)) }} />
        <span className="hr-pill__cap hr-pill__cap--right" />
        <span className="hr-pill__cap hr-pill__cap--left" />
    </span>
);

export const StatusPill = ({
    presence,
    phase,
    reduceMotion,
    onArm,
    onConfirm,
    pillRef,
}: {
    presence: RobotPresence;
    phase: PillPhase;
    reduceMotion: boolean;
    onArm: () => void;
    onConfirm: () => void;
    pillRef: React.RefObject<HTMLButtonElement | null>;
}) => {
    const faceEls = useRef<Partial<Record<FaceId, HTMLSpanElement>>>({});
    const [widths, widthsSet] = useState<Partial<Record<FaceId, number>>>({});
    const activeFace: FaceId = phase === "status" ? presence : phase;
    const shuttingDown = phase === "shutting-down";

    useLayoutEffect(() => {
        const measure = () => {
            const next: Partial<Record<FaceId, number>> = {};
            FACE_IDS.forEach((id) => {
                const el = faceEls.current[id];
                if (!el) return;
                next[id] = Math.max(CAP_PX, el.offsetWidth);
            });
            widthsSet((prev) => (widthsEqual(prev, next) ? prev : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        FACE_IDS.forEach((id) => {
            const el = faceEls.current[id];
            if (el) observer.observe(el);
        });
        return () => observer.disconnect();
    }, []);

    const measured = Object.values(widths).filter((value): value is number => value != null);
    const pillMax = measured.length ? Math.max(...measured) : 0;
    const presenceWidth = widths[presence];
    const activeWidth = widths[activeFace];
    const fillWidth = phase === "status" ? presenceWidth : widths[phase];
    const onClick = () => {
        if (shuttingDown) return;
        if (phase === "shutdown") {
            onConfirm();
            return;
        }
        if (presence === "ready" || presence === "idle") onArm();
    };

    return (
        <button
            ref={pillRef}
            type="button"
            className={[
                "hr-pill",
                phase !== "status" ? `hr-pill--${phase}` : "",
                presence === "offline" ? "hr-pill--offline" : "",
                reduceMotion ? "hr-pill--instant" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            style={activeWidth ? { width: px(activeWidth) } : undefined}
            aria-busy={shuttingDown ? true : undefined}
            onClick={onClick}
        >
            {presenceWidth && pillMax ? (
                <PillChrome
                    kind="line"
                    width={presenceWidth}
                    max={pillMax}
                    on={phase === "status"}
                />
            ) : null}
            {fillWidth && pillMax ? (
                <PillChrome
                    kind="fill"
                    width={fillWidth}
                    max={pillMax}
                    on={phase !== "status"}
                />
            ) : null}
            {PRESENCE_ORDER.map((id) => {
                const spec = PILLS[id];
                const on = activeFace === id;
                return (
                    <span
                        key={id}
                        ref={(node) => {
                            if (node) faceEls.current[id] = node;
                            else delete faceEls.current[id];
                        }}
                        className={`hr-pill__face hr-pill__face--status${on ? " is-on" : ""}`}
                        aria-hidden={on ? undefined : true}
                    >
                        <span className="hr-pill__dot">
                            <img alt="" className={spec.dotClass} src={spec.dot} />
                        </span>
                        <span className={`hr-pill__text ${spec.textClass}`}>{spec.label}</span>
                    </span>
                );
            })}
            {(Object.keys(ACTION_COPY) as Exclude<PillPhase, "status">[]).map((id) => {
                const spec = ACTION_COPY[id];
                const on = activeFace === id;
                return (
                    <span
                        key={id}
                        ref={(node) => {
                            if (node) faceEls.current[id] = node;
                            else delete faceEls.current[id];
                        }}
                        className={`hr-pill__face hr-pill__face--action${on ? " is-on" : ""}`}
                        aria-hidden={on ? undefined : true}
                    >
                        {spec.icon ? (
                            <img alt="" className="hr-pill__mark" src={spec.icon} />
                        ) : (
                            <span className="hr-pill__spinner" aria-hidden="true" />
                        )}
                        <span className="hr-pill__text hr-pill__text--shutdown">
                            {spec.label}
                            {id === "shutting-down" ? (
                                <span className="hr-button__ellipsis" aria-hidden="true" />
                            ) : null}
                        </span>
                    </span>
                );
            })}
        </button>
    );
};
