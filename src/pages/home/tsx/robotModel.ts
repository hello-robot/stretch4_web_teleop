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
 * @param rail Rail the card resolved, from railFor.
 * @returns One sentence naming the build and the interface the card opens.
 */
export const buildTitle = (robot: RobotRecord, rail: string | null): string => {
    if (!servesRails()) {
        return `${buildLabel(robot)} — this channel serves one interface, and this card opens it`;
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
 * The line the card shows about an unreleased checkout, or null for silence.
 *
 * A checkout with changes on top of a release names that release. Any other
 * unreleased checkout names its destination: a rail when a stable release is
 * set, and the unversioned page when it is not.
 *
 * @param robot Record the card was rendered from.
 * @param rail Rail the card resolved, from railFor.
 * @returns The warning text, or null when the card has nothing to warn about.
 */
export const buildWarning = (
    robot: RobotRecord,
    rail: string | null
): string | null => {
    // A channel that serves no rails serves one interface, built from one
    // branch. There is no release here for a robot to disagree with, so there
    // is nothing to warn about: bending that rule is what a preview is for.
    if (!servesRails()) return null;
    if (!isUnreleasedBuild(robot)) return null;
    const behind = releaseBehind(robot);
    if (behind && behind === rail) {
        return (
            `This robot has changes outside of ${behind}. That release's` +
            " interface may not match what the robot is running — test this" +
            " branch on its preview channel instead."
        );
    }
    const tail =
        "which may not match what the robot is running — test this branch on" +
        " its preview channel instead.";
    return rail
        ? `This checkout is not a release. This card opens the stable interface (${rail}), ${tail}`
        : `This checkout is not a release. This card opens the default interface, ${tail}`;
};

/**
 * Where the Connect control sends the operator.
 *
 * A card that resolves no rail keeps the unversioned page, which is every card
 * until a stable release is set, and every card on an origin that serves no
 * rails at all.
 */
export const operatorHref = (robot: RobotRecord, name: string): string => {
    const query = `?robot=${encodeURIComponent(name)}`;
    const rail = railFor(robot);
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
