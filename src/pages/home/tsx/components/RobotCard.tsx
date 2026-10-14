import configIcon from "home/public/icons/config.svg";
import mapMarkerIcon from "home/public/icons/map-marker.svg";
import pencilOffline from "home/public/icons/pencil-offline.svg";
import pencilOnline from "home/public/icons/pencil-online.svg";
import { BorderBeam } from "border-beam";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loginHandler } from "../index";
import {
    CardTone,
    holdsOperatorSeat,
    MapIndex,
    normalizeStatus,
    OperatorSeat,
    presenceFor,
    robotDisplayId,
    RobotRecord,
    RobotStatus,
    toneForStatus,
} from "../robotModel";
import { useLaunchingBeat } from "../useLaunchingBeat";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";
import { BranchTag } from "./BranchTag";
import { ConfigChecklist } from "./ConfigChecklist";
import { ConfigSheet } from "./ConfigSheet";
import { MapPickerSheet } from "./MapPickerSheet";
import { StatusPill } from "./StatusPill";
import { LaunchLogPanel } from "./LaunchLogPanel";
import { TeleopButton } from "./TeleopButton";

const PENCIL: Record<CardTone, string> = {
    lit: pencilOnline,
    dim: pencilOffline,
};

interface EditableRowProps {
    icon: string;
    label: string;
    tone: CardTone;
    editLabel: string;
    locked: boolean;
    onEdit: () => void;
}

const EditableRow = ({
    icon,
    label,
    tone,
    editLabel,
    locked,
    onEdit,
}: EditableRowProps) => (
    <div className="hr-row">
        <div className="hr-row__main">
            <img alt="" className="hr-row__icon" src={icon} />
            <span className="hr-row__label">{label}</span>
        </div>
        <button
            className={`hr-row__edit${locked ? " hr-row__edit--locked" : ""}`}
            type="button"
            aria-label={editLabel}
            aria-disabled={locked}
            onClick={() => {
                if (!locked) onEdit();
            }}
        >
            <img alt="" src={PENCIL[tone]} />
        </button>
    </div>
);

interface RobotCardProps {
    uid: string;
    robot: RobotRecord;
    maps: MapIndex;
    onError: (message: string) => void;
    revealIndex: number;
}

const REVEAL_STAGGER_MS = 90;

/** Recolors the beam to Hello Robot blue without letting the blur wash the card. */
const BRAND_BLUE_BEAM = `
[data-beam="{id}"]::before,
[data-beam="{id}"]::after {
  filter: blur(var(--beam-core-blur, 3px)) sepia(1) saturate(4) hue-rotate(168deg) brightness(0.85) !important;
}
[data-beam="{id}"] [data-beam-bloom] {
  filter: blur(var(--beam-bloom-blur, 10px)) sepia(1) saturate(4) hue-rotate(168deg) brightness(0.7) !important;
}
`;

type CardGlow = "outside" | "inner" | "breathe";

const glowFor = (status: RobotStatus, beat: boolean): CardGlow | null => {
    if (status === "launching" || beat) return "outside";
    if (status === "occupied" || status === "online") return "inner";
    if (status === "standby") return "breathe";
    return null;
};

export const RobotCard = ({
    uid,
    robot,
    maps,
    onError,
    revealIndex,
}: RobotCardProps) => {
    const [mapSheetOpen, mapSheetOpenSet] = useState(false);
    const [configSheetOpen, configSheetOpenSet] = useState(false);
    const [seat, seatSet] = useState<OperatorSeat | null>(null);
    const [logsOpen, logsOpenSet] = useState(false);
    const [manualLaunch, manualLaunchSet] = useState(false);
    /**
     * A relaunch driven from a settings sheet, tracked across the whole
     * stop -> standby -> launch -> online cycle. The card needs the phase, not
     * just a pending flag: it drives the Starting animation, which has to stay
     * up for the launch itself and not only for the stop.
     */
    const [restart, restartSet] = useState<{
        phase: "stopping" | "launching";
        mapId: string | null;
    } | null>(null);
    const [slotHeight, slotHeightSet] = useState<number | null>(null);
    const cardRef = useRef<HTMLElement>(null);
    const dialogRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!robot.uid) {
            seatSet(null);
            return;
        }
        return loginHandler.watchOperatorSeat(robot.uid, seatSet);
    }, [robot.uid]);

    const name = robot.name || uid;
    const status = normalizeStatus(robot.status);
    const presence = presenceFor(status, seat !== null);
    const tone = toneForStatus(robot.status);
    const mapName = robot.map_id
        ? maps[robot.map_id]?.name ?? robot.map_id
        : "No map selected";
    const { beat, beatUntil } = useLaunchingBeat(status);
    const reduceMotion = usePrefersReducedMotion();
    const glow = glowFor(status, beat);
    const pulsed = glow === "outside" || glow === "inner";

    useEffect(() => {
        if (status === "standby" || status === "offline") {
            manualLaunchSet(false);
            logsOpenSet(false);
        }
    }, [status]);

    useEffect(() => {
        if (!logsOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") logsOpenSet(false);
        };
        window.addEventListener("keydown", onKey);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialogRef.current?.focus();
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = previousOverflow;
        };
    }, [logsOpen]);

    const openLogs = () => {
        const height = cardRef.current?.getBoundingClientRect().height;
        if (height) slotHeightSet(height);
        manualLaunchSet(true);
        logsOpenSet(true);
    };

    const report = (what: string) => (err: unknown) =>
        onError(
            `${what} failed: ${err instanceof Error ? err.message : String(err)}`
        );

    const interfaceActive =
        status === "launching" || status === "online" || status === "occupied";

    const occupiedBy =
        (status === "online" || status === "occupied") &&
        seat &&
        !holdsOperatorSeat(seat, loginHandler.getUserUid())
            ? seat.initials || seat.email || "Another operator"
            : null;

    /**
     * Persist a sheet's staged edit, then make the robot pick it up. The daemon
     * reads map and config once per launch, so a running interface is stopped
     * and relaunched; the relaunch itself is issued by the effect below, once
     * the daemon reports standby.
     *
     * mapId is carried through rather than re-read from the record at relaunch
     * time, so a map chosen here is the one launched even if the RTDB watch has
     * not caught up.
     */
    const applyAndRestart = async (
        what: string,
        write: () => Promise<void>,
        mapId: string | null
    ) => {
        try {
            await write();
            mapSheetOpenSet(false);
            configSheetOpenSet(false);
            if (!interfaceActive) return;
            restartSet({ phase: "stopping", mapId });
            await loginHandler.requestRobotStop(uid);
        } catch (err) {
            restartSet(null);
            // The control node accepts a write only while empty, so a launch or
            // stop already in flight is rejected by the rules rather than
            // queued. That arrives as PERMISSION_DENIED, which otherwise reads
            // as an access problem on a robot the user can plainly see.
            const message = err instanceof Error ? err.message : String(err);
            onError(
                /PERMISSION_DENIED/i.test(message)
                    ? `${what} failed: the robot is handling another launch or stop, or you are not assigned to it. Try again in a moment.`
                    : `${what} failed: ${message}`
            );
        }
    };

    useEffect(() => {
        if (restart?.phase !== "stopping" || status !== "standby") return;
        const { mapId } = restart;
        restartSet({ phase: "launching", mapId });
        loginHandler.requestRobotLaunch(uid, mapId).catch((err) => {
            restartSet(null);
            report("Relaunching")(err);
        });
    }, [restart, status, uid]);

    // Relaunch landed, failed back to standby, or the robot dropped off.
    // standby is still in flight: the daemon reports it until launching begins.
    useEffect(() => {
        if (restart?.phase !== "launching") return;
        if (status === "launching" || status === "standby") return;
        restartSet(null);
    }, [restart, status]);

    const cardClass = [
        "hr-card",
        `hr-card--${tone}`,
        pulsed && !reduceMotion ? "hr-card--beam" : "",
        glow === "breathe" ? "hr-card--breathe" : "",
    ]
        .filter(Boolean)
        .join(" ");
    const rowsLayoutId = reduceMotion ? undefined : `hr-card-rows-${uid}`;

    const card = (expanded: boolean) => (
        <motion.article
            ref={expanded ? dialogRef : cardRef}
            layout={!reduceMotion}
            layoutId={reduceMotion ? undefined : `hr-card-${uid}`}
            className={[
                cardClass,
                expanded ? "hr-card--logs" : "hr-card--reveal",
            ].join(" ")}
            style={
                expanded
                    ? undefined
                    : { animationDelay: `${revealIndex * REVEAL_STAGGER_MS}ms` }
            }
            role={expanded ? "dialog" : undefined}
            aria-modal={expanded ? true : undefined}
            aria-label={
                expanded ? `${robotDisplayId(name)} launch logs` : undefined
            }
            tabIndex={expanded ? -1 : undefined}
            transition={
                reduceMotion
                    ? { duration: 0 }
                    : { layout: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } }
            }
        >
            <header className="hr-card__head">
                <span className="hr-card__id">{robotDisplayId(name)}</span>
                <StatusPill presence={presence} />
            </header>

            {expanded && (
                <div className="hr-card__compact">
                    <div className="hr-card__compact-map">
                        <img
                            alt=""
                            className="hr-card__compact-icon"
                            src={mapMarkerIcon}
                        />
                        <span>{mapName}</span>
                    </div>
                    <div className="hr-card__config">
                        <span className="hr-card__compact-label">
                            <img
                                alt=""
                                className="hr-card__compact-icon"
                                src={configIcon}
                            />
                            Config
                        </span>
                        <ConfigChecklist robot={robot} tone={tone} />
                    </div>
                </div>
            )}

            <div className="hr-card__body">
                {expanded ? (
                    <motion.div
                        layoutId={rowsLayoutId}
                        className="hr-launch-log-slot"
                    >
                        <LaunchLogPanel fleetId={uid} />
                    </motion.div>
                ) : (
                    <motion.div
                        layoutId={rowsLayoutId}
                        className="hr-card__rows"
                    >
                        <EditableRow
                            icon={mapMarkerIcon}
                            label={mapName}
                            tone={tone}
                            editLabel="Change map"
                            locked={false}
                            onEdit={() => mapSheetOpenSet(true)}
                        />
                        <div className="hr-card__config">
                            <EditableRow
                                icon={configIcon}
                                label="Config"
                                tone={tone}
                                editLabel="Edit config"
                                locked={false}
                                onEdit={() => configSheetOpenSet(true)}
                            />
                            <ConfigChecklist robot={robot} tone={tone} />
                        </div>
                    </motion.div>
                )}

                <div className="hr-card__actions">
                    <TeleopButton
                        status={status}
                        seat={seat}
                        beat={beat}
                        beatUntil={beatUntil}
                        manualLaunch={manualLaunch}
                        logsOpen={expanded}
                        restarting={restart !== null}
                        onOpenLogs={openLogs}
                        operatorHref={`/operator/?robot=${encodeURIComponent(name)}`}
                        onLaunch={() =>
                            loginHandler
                                .requestRobotLaunch(uid, robot.map_id ?? null)
                                .catch(report("Launch"))
                        }
                        onStop={() => {
                            // Stop is also the abort on the Starting control.
                            // Drop any pending relaunch, or the effect would
                            // bring the interface straight back up at standby.
                            restartSet(null);
                            return loginHandler
                                .requestRobotStop(uid)
                                .catch((err) => {
                                    report("Stop")(err);
                                    throw err;
                                });
                        }}
                    />
                    <BranchTag
                        branch={
                            robot.branch || (status === "offline" ? "main" : "")
                        }
                        tone={tone}
                    />
                </div>
            </div>

            {!expanded && (
                <>
                    <MapPickerSheet
                        open={mapSheetOpen}
                        maps={maps}
                        selectedMapId={robot.map_id ?? null}
                        interfaceActive={interfaceActive}
                        occupiedBy={occupiedBy}
                        busy={restart !== null}
                        onClose={() => mapSheetOpenSet(false)}
                        onApply={(mapId) =>
                            applyAndRestart(
                                "Saving map",
                                () => loginHandler.setRobotMap(uid, mapId),
                                mapId
                            )
                        }
                    />
                    <ConfigSheet
                        open={configSheetOpen}
                        robot={robot}
                        interfaceActive={interfaceActive}
                        occupiedBy={occupiedBy}
                        busy={restart !== null}
                        onClose={() => configSheetOpenSet(false)}
                        onApply={(changes) =>
                            applyAndRestart(
                                "Applying config",
                                () =>
                                    loginHandler.setRobotConfigs(uid, changes),
                                robot.map_id ?? null
                            )
                        }
                    />
                </>
            )}
        </motion.article>
    );

    return (
        <LayoutGroup id={`hr-robot-${uid}`}>
            <BorderBeam
                className="hr-card-beam"
                size={glow === "inner" ? "pulse-inner" : "pulse-outside"}
                colorVariant="ocean"
                theme="dark"
                borderRadius={7}
                staticColors
                hueRange={0}
                strength={glow === "inner" ? 0.4 : 0.7}
                glowSize={glow === "inner" ? 0.55 : 1}
                active={pulsed && !reduceMotion && !logsOpen}
                css={BRAND_BLUE_BEAM}
            >
                {logsOpen ? (
                    <div
                        className="hr-card-slot"
                        style={slotHeight ? { height: slotHeight } : undefined}
                        aria-hidden
                    />
                ) : (
                    card(false)
                )}
            </BorderBeam>
            {logsOpen &&
                createPortal(
                    <>
                        <AnimatePresence>
                            <motion.button
                                key="launch-log-overlay"
                                type="button"
                                className="hr-log-overlay"
                                aria-label="Close logs"
                                onClick={() => logsOpenSet(false)}
                                initial={reduceMotion ? false : { opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={
                                    reduceMotion
                                        ? { duration: 0 }
                                        : { duration: 0.2 }
                                }
                            />
                        </AnimatePresence>
                        <div className="hr-log-stage">{card(true)}</div>
                    </>,
                    document.body
                )}
        </LayoutGroup>
    );
};
