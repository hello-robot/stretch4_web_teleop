import featuresJson from "../../../../features.json";

export type RobotStatus =
    | "online"
    | "offline"
    | "standby"
    | "launching"
    | "occupied";

/** Shape of `robots/{id}/build` in RTDB: how the robot's checkout describes. */
export interface BuildRecord {
    describe?: string;
    rail?: string;
}

/** Shape of `robots/{id}` in RTDB plus the `is_active` assignment flag. */
export interface RobotRecord {
    name?: string;
    status?: RobotStatus | string;
    uid?: string;
    last_updated?: number;
    branch?: string;
    build?: BuildRecord;
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

/**
 * Whether this lobby is the one that serves rails.
 *
 * A version built for the live site is given its own origin to compare
 * against. A preview channel is deliberately not, so the comparison fails
 * there, and so it does in firebase mode where the robot serves this same
 * lobby at its own address. Both serve exactly one interface, which is the
 * one they published, and neither has a release to measure a robot against.
 *
 * The configured value is reduced to its origin before comparing, because
 * location.origin carries no trailing slash and no path.
 *
 * @returns True when this page's origin is the configured Hosting origin;
 *     false when they differ, or the configured value is unset or not a URL.
 */
export const servesRails = (): boolean => {
    const configured = process.env.PUBLIC_HOSTING_ORIGIN;
    if (!configured) return false;
    try {
        return new URL(configured).origin === location.origin;
    } catch {
        // new URL throws on a value that is not a URL, which names no origin.
        return false;
    }
};

/**
 * What the tag on a card shows: the build the robot reported, else its branch.
 *
 * A describe names a commit; a branch name does not, so the describe is the
 * better answer whenever the robot has published one.
 */
export const buildLabel = (robot: RobotRecord): string => {
    // Where no rails are served, the card is showing a branch under test, and
    // the branch is what names it. A describe names a commit, which answers a
    // question nobody is asking on a preview channel.
    if (!servesRails() && robot.branch && robot.branch !== "HEAD") {
        return robot.branch;
    }
    return robot.build?.describe || branchLabel(robot.branch);
};

/**
 * What the tag on a card means, spelled out for its tooltip.
 *
 * The label alone cannot say whether the card routes to a rail: that also
 * depends on the origin, and on whether the rail was reported or defaulted.
 *
 * @param robot Record the card was rendered from.
 * @param wanted Rail the robot routes to, from railFor.
 * @param rail Rail the card opens, from routedRail.
 * @returns One sentence naming the build and the interface the card opens.
 */
export const buildTitle = (
    robot: RobotRecord,
    wanted: string | null,
    rail: string | null = wanted
): string => {
    if (!servesRails()) {
        return `${buildLabel(robot)} — this channel serves one interface, and this card opens it`;
    }
    if (wanted !== null && wanted !== rail) {
        return rail
            ? `Release ${wanted} is not deployed — this card opens the stable release, ${rail}`
            : `Release ${wanted} is not deployed and no stable release is set — this card opens the default interface`;
    }
    if (rail && robot.build?.rail === rail) {
        return `Release ${rail} — this card opens that version of the interface`;
    }
    if (rail && releaseBehind(robot) === rail) {
        return `${buildLabel(robot)} has changes outside of ${rail} — this card opens the ${rail} interface`;
    }
    if (rail && isUnreleasedBuild(robot)) {
        return `${buildLabel(robot)} is not a release — this card opens the stable release, ${rail}`;
    }
    if (rail) {
        return `This robot reports no build — this card opens the stable release, ${rail}`;
    }
    return `${buildLabel(robot)} — no stable release is set, so this card opens the default interface`;
};

/**
 * Release tags only. Mirrors the `.validate` on `robots/<id>/build/rail` and
 * `RELEASE_TAG` in the daemon; all three move together.
 */
const RAIL = /^v\d+\.\d+\.\d+(-(alpha|beta|rc)\d+)?$/;

/**
 * The stable release this lobby was built against, or null when it has none.
 *
 * Baked in beside the lobby, so the pointer and the rail tree it names ship in
 * one Hosting version and cannot drift apart.
 */
const stableRail = (): string | null => {
    const stable = process.env.PUBLIC_STABLE_RAIL;
    return stable && RAIL.test(stable) ? stable : null;
};

/**
 * A git describe of a checkout with changes on top of a release tag: commits
 * after it (`-<count>-g<commit>`), uncommitted changes (`-dirty`), or both.
 * The first group is the tag, held to the RAIL grammar.
 */
const PAST_RELEASE = new RegExp(
    `^(${RAIL.source.slice(1, -1)})(?:-\\d+-g[0-9a-f]+(?:-dirty)?|-dirty)$`
);

/**
 * The release a robot's checkout has changes on top of.
 *
 * Read from the describe the daemon publishes, which names the nearest
 * release tag reachable from the robot's HEAD.
 *
 * @param robot Record the card was rendered from.
 * @returns The release tag, or null when the robot reports no build, sits
 *     exactly on a tag, or its describe names no release tag.
 */
export const releaseBehind = (robot: RobotRecord): string | null =>
    robot.build?.describe?.match(PAST_RELEASE)?.[1] ?? null;

/**
 * The rail a robot routes to, or null for the unversioned page.
 *
 * A robot reporting a release tag routes to that rail. A robot whose checkout
 * has changes on top of a release tag routes to that tag's rail. Everything
 * else — a robot that predates the tag system, and a checkout with no release
 * tag behind it — takes the stable release.
 *
 * Only the Hosting origin serves rails. In firebase mode `server.js` mounts
 * `dist-firebase` at `/`, so the robot serves this same lobby at its own
 * address, where no `r/` tree exists and the operator page already comes from
 * the robot's own checkout. Preview channels are whole-site builds on their
 * own origin. Both keep the unversioned path.
 *
 * @param robot Record the card was rendered from.
 * @returns The release tag naming the rail, or null for the unversioned page.
 */
export const railFor = (robot: RobotRecord): string | null => {
    if (!servesRails()) return null;
    const rail = robot.build?.rail;
    if (rail && RAIL.test(rail)) return rail;
    return releaseBehind(robot) ?? stableRail();
};

/**
 * The rail a card opens, once the origin has said whether the robot's own is
 * deployed.
 *
 * A robot whose release is not on the site takes the stable release, the same
 * as a robot with no release of its own.
 *
 * @param wanted Rail the robot routes to, from railFor.
 * @param wantedAvailable Whether that rail is deployed, from useRailAvailable;
 *     null while the probe is outstanding.
 * @returns The stable release when the wanted rail is absent, which is null
 *     for the unversioned page when none is set; otherwise the wanted rail.
 */
export const routedRail = (
    wanted: string | null,
    wantedAvailable: boolean | null
): string | null =>
    wanted !== null && wantedAvailable === false ? stableRail() : wanted;

/**
 * True when a robot reports a build that names no release.
 *
 * Distinct from a robot reporting no build at all, which has simply not been
 * migrated. This one is running a checkout nobody cut a rail from, so no
 * deployed operator page matches it and its branch belongs on a preview
 * channel.
 */
export const isUnreleasedBuild = (robot: RobotRecord): boolean =>
    Boolean(robot.build) && !(robot.build?.rail && RAIL.test(robot.build.rail));

/**
 * Two-line warning shown when the interface a card opens may not match the
 * robot's checkout, or null when they match.
 *
 * @param robot Record the card was rendered from.
 * @param wanted Rail the robot routes to, from railFor.
 * @param rail Rail the card opens, from routedRail.
 * @returns The warning text, or null when the card has nothing to warn about.
 */
export const buildWarning = (
    robot: RobotRecord,
    wanted: string | null,
    rail: string | null = wanted
): string | null => {
    if (!servesRails()) return null;
    const behind = releaseBehind(robot);
    const defaultLine = rail
        ? `→ Defaults to stable (${rail})`
        : "→ Defaults to default interface";
    if (wanted !== null && wanted !== rail) {
        return `Release ${wanted} not deployed\n${defaultLine}`;
    }
    if (!isUnreleasedBuild(robot)) return null;
    if (behind && behind === rail) {
        return `Unreleased changes on ${behind}\n→ Routes to ${behind}`;
    }
    return `Checkout is not a release\n${defaultLine}`;
};

/**
 * The line the card shows when the rail it opens is not on the site.
 *
 * routedRail has already replaced a robot's own undeployed release with the
 * stable one, so this is the stable release itself being absent.
 *
 * @param rail Rail the card opens, from routedRail.
 * @param railAvailable Whether that rail is deployed, from useRailAvailable;
 *     null while the probe is outstanding.
 * @returns The notice text, or null when the rail is deployed, is still being
 *     probed, or the card routes to no rail.
 */
export const railNotice = (
    rail: string | null,
    railAvailable: boolean | null
): string | null =>
    rail !== null && railAvailable === false
        ? `Release ${rail} is not deployed`
        : null;

/**
 * What a card's control does: "start" launches the interface, "enter" opens
 * the operator page, and "other" is any control that does neither.
 */
export type CardControl = "start" | "enter" | "other";

/** What the state of a card's rail does to the control the card would show. */
export type RailGate = "open" | "pending" | "refused";

/**
 * Decide whether a card's control is shown, waits on the rail probe, or is
 * replaced by the reason a connection would be refused.
 *
 * @param control What the control the card would show does.
 * @param railAvailable Whether the card's rail is deployed, from
 *     useRailAvailable; null while the probe is outstanding.
 * @param refusal Why a connection would be refused, or null when it would
 *     not be.
 * @returns "refused" for a start or enter control when there is a refusal,
 *     "pending" for an enter control while the probe is outstanding, and
 *     "open" otherwise.
 */
export const railGate = (
    control: CardControl,
    railAvailable: boolean | null,
    refusal: string | null
): RailGate => {
    if (control === "other") return "open";
    if (refusal !== null) return "refused";
    return control === "enter" && railAvailable === null ? "pending" : "open";
};

/**
 * Where the Connect control sends the operator.
 *
 * A card that opens no rail keeps the unversioned page, which is every card
 * until a stable release is set, and every card on an origin that serves no
 * rails at all.
 *
 * @param rail Rail the card opens, from routedRail.
 * @param name Robot name the operator page is asked to connect to.
 * @returns The operator page's path and query on this origin.
 */
export const operatorHref = (rail: string | null, name: string): string => {
    const query = `?robot=${encodeURIComponent(name)}`;
    return rail ? `/r/${rail}/operator/${query}` : `/operator/${query}`;
};

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
