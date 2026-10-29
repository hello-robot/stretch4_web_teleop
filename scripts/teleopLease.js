const { initializeApp } = require("firebase/app");
const {
    getAuth,
    signInWithEmailAndPassword,
} = require("firebase/auth");
const {
    getDatabase,
    get,
    ref,
    runTransaction,
    update,
} = require("firebase/database");

/**
 * Deadline on every lease call. An unreachable Realtime Database queues work
 * instead of failing it, so without this a local operator would wait on
 * Firebase for as long as Firebase stayed away.
 */
const LEASE_TIMEOUT_MS = Number(
    process.env.WEB_TELEOP_LEASE_TIMEOUT_MS || 8000,
);

/**
 * Race a lease call against the deadline above.
 *
 * @param {Promise<any>} promise Firebase call to bound.
 * @param {string} label Name used in the timeout message.
 *
 * @returns {Promise<any>} The call's result, or a rejection at the deadline.
 */
function withLeaseTimeout(promise, label) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(`${label} timed out after ${LEASE_TIMEOUT_MS}ms`),
                ),
            LEASE_TIMEOUT_MS,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function localSeat(sessionId, active, now = Date.now()) {
    return {
        active,
        transport: "local",
        sessionId,
        uid: `local:${sessionId}`,
        alias: "Local",
        claimedAt: now,
    };
}

function claimLocalSeat(current, sessionId, now) {
    if (current?.active === true && current.sessionId !== sessionId) {
        return;
    }
    return localSeat(sessionId, true, now);
}

function localOperatorJoinResult({
    operSession,
    sessionId,
    connected,
    leaseCommitted,
}) {
    if (operSession && operSession !== sessionId) return "occupied";
    if (!leaseCommitted) return "denied";
    if (!connected) return "disconnected";
    return "accepted";
}

function releaseLocalSeat(current, sessionId, now) {
    if (
        current?.transport !== "local" ||
        current.sessionId !== sessionId
    ) {
        return;
    }
    return localSeat(sessionId, false, now);
}

function releaseLocalSeatTransaction(current, sessionId, now) {
    return current === null
        ? localSeat(sessionId, false, now)
        : releaseLocalSeat(current, sessionId, now);
}

function createTeleopLeaseClient(env = process.env) {
    const app = initializeApp(
        {
            apiKey: env.PUBLIC_FIREBASE_API_KEY,
            authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
            databaseURL: env.PUBLIC_FIREBASE_DATABASE_URL,
            projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
            storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET,
            messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
            appId: env.PUBLIC_FIREBASE_APP_ID,
            measurementId: env.PUBLIC_FIREBASE_MEASUREMENT_ID,
        },
        "teleop-lease-server",
    );
    const auth = getAuth(app);
    const db = getDatabase(app);
    const fleetId = env.HELLO_FLEET_ID;
    const signedIn = signInWithEmailAndPassword(
        auth,
        env.ROBOT_USERNAME,
        env.ROBOT_PASSWORD,
    );

    const currentOperatorRef = () =>
        ref(db, `rooms/${auth.currentUser.uid}/operator`);
    const ready = signedIn.then(async () => {
        const seatRef = currentOperatorRef();
        const current = (await get(seatRef)).val();
        if (current?.transport !== "local") return;
        const staleSessionId = current.sessionId;
        await runTransaction(seatRef, (transactionCurrent) => {
            return releaseLocalSeatTransaction(
                transactionCurrent,
                staleSessionId,
            );
        });
    });

    const operatorRef = async () => {
        await ready;
        return currentOperatorRef();
    };

    /**
     * Claim the operator seat for a local (Tailscale) session.
     *
     * @param {string} sessionId Local operator session claiming the seat.
     *
     * @returns {Promise<"claimed"|"held"|"unavailable">} claimed when this
     *     session now holds the seat, held when a Firebase operator holds it,
     *     and unavailable when Firebase could not be reached to find out.
     */
    async function claimLocal(sessionId) {
        let result;
        try {
            result = await withLeaseTimeout(
                operatorRef().then((seatRef) =>
                    runTransaction(seatRef, (current) =>
                        claimLocalSeat(current, sessionId),
                    ),
                ),
                "local teleop lease claim",
            );
        } catch (error) {
            console.error("Local teleop lease unreachable:", error.message);
            return "unavailable";
        }
        if (!result.committed) {
            return "held";
        }
        try {
            await withLeaseTimeout(
                update(ref(db, `robots/${fleetId}`), {
                    status: "occupied",
                }),
                "local teleop status update",
            );
        } catch (error) {
            console.error(
                "Local teleop lease status update failed:",
                error.message,
            );
        }
        return "claimed";
    }

    /**
     * Release the operator seat held by a local session.
     *
     * @param {string} sessionId Local operator session releasing the seat.
     *
     * @returns {Promise<boolean>} True when the seat was released. False when
     *     this session did not hold it, or when Firebase was unreachable --
     *     the seat's onDisconnect handler clears it in that case.
     */
    async function releaseLocal(sessionId) {
        try {
            const seatRef = await withLeaseTimeout(
                operatorRef(),
                "local teleop lease release",
            );
            const current = (
                await withLeaseTimeout(get(seatRef), "local teleop seat read")
            ).val();
            if (
                current?.transport !== "local" ||
                current.sessionId !== sessionId
            ) {
                return false;
            }
            const result = await withLeaseTimeout(
                runTransaction(seatRef, (current) =>
                    releaseLocalSeatTransaction(current, sessionId),
                ),
                "local teleop lease release",
            );
            if (result.committed) {
                await withLeaseTimeout(
                    update(ref(db, `robots/${fleetId}`), {
                        status: "online",
                    }),
                    "local teleop status update",
                );
            }
            return result.committed;
        } catch (error) {
            console.error("Local teleop lease release failed:", error.message);
            return false;
        }
    }

    return {
        claimLocal,
        ready,
        releaseLocal,
    };
}

module.exports = {
    claimLocalSeat,
    createTeleopLeaseClient,
    localOperatorJoinResult,
    releaseLocalSeat,
    releaseLocalSeatTransaction,
};
