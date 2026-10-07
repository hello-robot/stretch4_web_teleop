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
    MapIndex,
    normalizeStatus,
    OperatorSeat,
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

const PENCIL: Record<CardTone, string> = { lit: pencilOnline, dim: pencilOffline };

interface EditableRowProps {
    icon: string;
    label: string;
    tone: CardTone;
    editLabel: string;
    locked: boolean;
    onEdit: () => void;
}

const EditableRow = ({ icon, label, tone, editLabel, locked, onEdit }: EditableRowProps) => (
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

export const RobotCard = ({ uid, robot, maps, onError, revealIndex }: RobotCardProps) => {
    const [mapSheetOpen, mapSheetOpenSet] = useState(false);
    const [configSheetOpen, configSheetOpenSet] = useState(false);
    const [seat, seatSet] = useState<OperatorSeat | null>(null);
    const [logsOpen, logsOpenSet] = useState(false);
    const [manualLaunch, manualLaunchSet] = useState(false);
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
    const tone = toneForStatus(robot.status);
    const mapName = robot.map_id ? maps[robot.map_id]?.name ?? robot.map_id : "No map selected";
    const settingsLocked = status !== "standby";
    const { beat, beatUntil } = useLaunchingBeat(status);
    const reduceMotion = usePrefersReducedMotion();
    const glow = glowFor(status, beat);
    const pulsed = glow === "outside" || glow === "inner";

    useEffect(() => {
        if (!settingsLocked) return;
        mapSheetOpenSet(false);
        configSheetOpenSet(false);
    }, [settingsLocked]);

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
        onError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);

    const cardClass = [
        "hr-card",
        `hr-card--${tone}`,
        pulsed && !reduceMotion ? "hr-card--beam" : "",
        glow === "breathe" ? "hr-card--breathe" : "",
    ].filter(Boolean).join(" ");
    const rowsLayoutId = reduceMotion ? undefined : `hr-card-rows-${uid}`;

    const card = (expanded: boolean) => (
        <motion.article
            ref={expanded ? dialogRef : cardRef}
            layout={!reduceMotion}
            layoutId={reduceMotion ? undefined : `hr-card-${uid}`}
            className={[cardClass, expanded ? "hr-card--logs" : "hr-card--reveal"].join(" ")}
            style={expanded ? undefined : { animationDelay: `${revealIndex * REVEAL_STAGGER_MS}ms` }}
            role={expanded ? "dialog" : undefined}
            aria-modal={expanded ? true : undefined}
            aria-label={expanded ? `${robotDisplayId(name)} launch logs` : undefined}
            tabIndex={expanded ? -1 : undefined}
            transition={reduceMotion ? { duration: 0 } : { layout: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } }}
        >
            <header className="hr-card__head">
                <span className="hr-card__id">{robotDisplayId(name)}</span>
                <StatusPill status={status} />
            </header>

            {expanded && (
                <div className="hr-card__compact">
                    <div className="hr-card__compact-map">
                        <img alt="" className="hr-card__compact-icon" src={mapMarkerIcon} />
                        <span>{mapName}</span>
                    </div>
                    <div className="hr-card__config">
                        <span className="hr-card__compact-label">
                            <img alt="" className="hr-card__compact-icon" src={configIcon} />
                            Config
                        </span>
                        <ConfigChecklist robot={robot} tone={tone} />
                    </div>
                </div>
            )}

            <div className="hr-card__body">
                {expanded ? (
                    <motion.div layoutId={rowsLayoutId} className="hr-launch-log-slot">
                        <LaunchLogPanel fleetId={uid} />
                    </motion.div>
                ) : (
                    <motion.div layoutId={rowsLayoutId} className="hr-card__rows">
                        <EditableRow
                            icon={mapMarkerIcon}
                            label={mapName}
                            tone={tone}
                            editLabel="Change map"
                            locked={settingsLocked}
                            onEdit={() => mapSheetOpenSet(true)}
                        />
                        <div className="hr-card__config">
                            <EditableRow
                                icon={configIcon}
                                label="Config"
                                tone={tone}
                                editLabel="Edit config"
                                locked={settingsLocked}
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
                        onOpenLogs={openLogs}
                        operatorHref={`/operator/?robot=${encodeURIComponent(name)}`}
                        onLaunch={() =>
                            loginHandler
                                .requestRobotLaunch(uid, robot.map_id ?? null)
                                .catch(report("Launch"))
                        }
                        onStop={() =>
                            loginHandler.requestRobotStop(uid).catch((err) => {
                                report("Stop")(err);
                                throw err;
                            })
                        }
                    />
                    <BranchTag
                        branch={robot.branch || (status === "offline" ? "main" : "")}
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
                        onClose={() => mapSheetOpenSet(false)}
                        onSelect={(mapId) => {
                            mapSheetOpenSet(false);
                            loginHandler.setRobotMap(uid, mapId).catch(report("Saving map"));
                        }}
                    />
                    <ConfigSheet
                        open={configSheetOpen}
                        robot={robot}
                        onClose={() => configSheetOpenSet(false)}
                        onToggle={(flag, enabled) =>
                            loginHandler.setRobotConfig(uid, flag, enabled).catch(report("Saving config"))
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
            {logsOpen && createPortal(
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
                            transition={reduceMotion ? { duration: 0 } : { duration: 0.2 }}
                        />
                    </AnimatePresence>
                    <div className="hr-log-stage">
                        {card(true)}
                    </div>
                </>,
                document.body,
            )}
        </LayoutGroup>
    );
};
