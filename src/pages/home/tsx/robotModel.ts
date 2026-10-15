import featuresJson from "../../../../features.json";

export type RobotStatus =
    | "online"
    | "offline"
    | "standby"
    | "launching"
    | "occupied";

/** Shape of `robots/{id}` in RTDB plus the `is_active` assignment flag. */
export interface RobotRecord {
    name?: string;
    status?: RobotStatus | string;
    uid?: string;
    last_updated?: number;
    branch?: string;
    map_id?: string | null;
    config?: Record<string, boolean>;
    is_active?: boolean;
}

export interface MapRecord {
    name?: string;
    thumb_png_base64?: string;
}

export type MapIndex = Record<string, MapRecord>;

/** Person currently in `rooms/<robotAuthUid>/operator`, if the seat is active. */
export interface OperatorSeat {
    uid: string;
    initials?: string;
    email?: string;
}

export const holdsOperatorSeat = (
    seat: OperatorSeat | null,
    myUid: string | undefined
): boolean => Boolean(seat && myUid && seat.uid === myUid);

/**
 * What the branch tag shows for a robot.
 *
 * The daemon publishes the branch checked out on the robot as of its last
 * status change, so this value can trail the robot's current tree. That is the
 * reading to keep: it names the code the running interface was launched from,
 * which is what an operator needs to know.
 *
 * Anything that names no branch reads as "unknown": a robot that has never
 * published one, a tree git could not read, or a detached HEAD, which git
 * reports as the literal string "HEAD". Guessing a branch name here would put
 * a claim on the card that nothing on the robot supports.
 */
export const branchLabel = (branch: string | undefined): string =>
    !branch || branch === "HEAD" ? "unknown" : branch;

/** Visual tone of a card: lit when the robot daemon is reachable, dim when not. */
export type CardTone = "lit" | "dim";

export const toneForStatus = (status: string | undefined): CardTone =>
    status === "offline" || status === undefined ? "dim" : "lit";

export const normalizeStatus = (status: string | undefined): RobotStatus =>
    (["online", "offline", "standby", "launching", "occupied"] as const).find(
        (s) => s === status
    ) ?? "offline";

/**
 * What a card announces about the robot, one step coarser than `RobotStatus`:
 * offline = daemon unreachable, idle = daemon up but no interface (including
 * while it launches), ready = interface up and free, in-use = someone is driving.
 */
export type RobotPresence = "offline" | "idle" | "ready" | "in-use";

export const presenceFor = (
    status: RobotStatus,
    seatTaken: boolean
): RobotPresence => {
    if (status === "offline") return "offline";
    if (status === "standby" || status === "launching") return "idle";
    // `occupied` is the robot's own word for "an operator joined"; the seat
    // catches the window where the room fills before the robot writes status.
    return status === "occupied" || seatTaken ? "in-use" : "ready";
};

/** Dashboard order: reachable robots lead; equal ranks keep the incoming order. */
export const compareOnlineFirst = (a: RobotRecord, b: RobotRecord): number =>
    Number(normalizeStatus(b.status) !== "offline") -
    Number(normalizeStatus(a.status) !== "offline");

/** `stretch-se4-4017` -> `4017`; falls back to the full name. */
export const robotDisplayId = (name: string): string =>
    name.match(/(\d{4})$/)?.[1] ?? name;

type FeatureEntry = { enabled: boolean; description?: string };

/** Feature flags declared in features.json: the single source of truth for config rows. */
export const FEATURE_FLAGS: Record<string, FeatureEntry> = featuresJson;

export const FEATURE_LABELS: Record<string, string> = {
    voice_control_interface: "Stretch Voice Control (SVC)",
    voice_input_recording: "Record voice audio",
    local_collision_avoidance: "Local collision avoidance",
};

export const featureLabel = (flag: string): string =>
    FEATURE_LABELS[flag] ?? flag.replace(/_/g, " ");

/** Effective flag value for a robot: its RTDB override, else the features.json default. */
export const effectiveFlag = (robot: RobotRecord, flag: string): boolean =>
    robot.config?.[flag] ?? Boolean(FEATURE_FLAGS[flag]?.enabled);
