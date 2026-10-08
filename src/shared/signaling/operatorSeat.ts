/** Keep these aligned with the stale clause in database.rules.json. */
export const OPERATOR_SEAT_HEARTBEAT_MS = 5000;
export const OPERATOR_SEAT_STALE_MS = 20000;

type OperatorSeatSnapshot = {
    active?: boolean;
    transport?: string;
    uid?: string;
    sessionId?: string;
    claimedAt?: number;
} | null;

/**
 * True when a firebase claim must leave the seat alone.
 * The same account can replace its own seat. Any other firebase seat is free
 * once claimedAt is missing or older than {@link OPERATOR_SEAT_STALE_MS}.
 * An active local seat stays exclusive.
 */
export function firebaseSeatHeldByOther(
    current: OperatorSeatSnapshot,
    uid: string | undefined,
    sessionId: string,
    now: number,
): boolean {
    if (!current || current.active !== true) return false;
    if (current.sessionId === sessionId) return false;
    if (current.transport === "local") return true;
    if (uid && current.uid === uid) return false;
    if (typeof current.claimedAt !== "number") return false;
    return now - current.claimedAt <= OPERATOR_SEAT_STALE_MS;
}
