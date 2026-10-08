/** Keep these aligned with the stale clause in database.rules.json. */
export const OPERATOR_SEAT_HEARTBEAT_MS = 5000;
export const OPERATOR_SEAT_STALE_MS = 20000;

const OPERATOR_TAKEOVER_KEY = "hr-operator-takeover";

/** Remember that this tab's Launch click should replace the account's other session. */
export function markOperatorTakeover() {
    sessionStorage.setItem(OPERATOR_TAKEOVER_KEY, "1");
}

/** Read and clear the takeover flag for this navigation. */
export function consumeOperatorTakeover(): boolean {
    const takeover = sessionStorage.getItem(OPERATOR_TAKEOVER_KEY) === "1";
    if (takeover) sessionStorage.removeItem(OPERATOR_TAKEOVER_KEY);
    return takeover;
}

type OperatorSeatSnapshot = {
    active?: boolean;
    transport?: string;
    uid?: string;
    sessionId?: string;
    claimedAt?: number;
} | null;

/** Why a claim left the current firebase seat alone. */
export type OperatorSeatBlock = "same-account" | "other";

/**
 * A live firebase seat is exclusive, including for the same account.
 * A missing claimedAt, or one older than {@link OPERATOR_SEAT_STALE_MS},
 * can still be taken. An active local seat stays exclusive.
 */
export function firebaseSeatBlock(
    current: OperatorSeatSnapshot,
    uid: string | undefined,
    sessionId: string,
    now: number,
    takeover = false,
): OperatorSeatBlock | null {
    if (!current || current.active !== true) return null;
    if (current.sessionId === sessionId) return null;
    if (current.transport === "local") return "other";
    const stale =
        typeof current.claimedAt !== "number" ||
        now - current.claimedAt > OPERATOR_SEAT_STALE_MS;
    if (stale) return null;
    if (uid && current.uid === uid) return takeover ? null : "same-account";
    return "other";
}

export function firebaseSeatHeldByOther(
    current: OperatorSeatSnapshot,
    uid: string | undefined,
    sessionId: string,
    now: number,
    takeover = false,
): boolean {
    return firebaseSeatBlock(current, uid, sessionId, now, takeover) !== null;
}
