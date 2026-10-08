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
    myUid: string | undefined,
): boolean => Boolean(seat && myUid && seat.uid === myUid);

/** Visual tone of a card: lit when the robot daemon is reachable, dim when not. */
export type CardTone = "lit" | "dim";

export const toneForStatus = (status: string | undefined): CardTone =>
    status === "offline" || status === undefined ? "dim" : "lit";

export const normalizeStatus = (status: string | undefined): RobotStatus =>
    (["online", "offline", "standby", "launching", "occupied"] as const).find(
        (s) => s === status,
    ) ?? "offline";

/** Dashboard order: cards that show Online lead; equal ranks keep the incoming order. */
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
};

export const featureLabel = (flag: string): string =>
    FEATURE_LABELS[flag] ?? flag.replace(/_/g, " ");

/** Effective flag value for a robot: its RTDB override, else the features.json default. */
export const effectiveFlag = (robot: RobotRecord, flag: string): boolean =>
    robot.config?.[flag] ?? Boolean(FEATURE_FLAGS[flag]?.enabled);
