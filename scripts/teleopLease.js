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
            apiKey: env.apiKey,
            authDomain: env.authDomain,
            databaseURL: env.databaseURL,
            projectId: env.projectId,
            storageBucket: env.storageBucket,
            messagingSenderId: env.messagingSenderId,
            appId: env.appId,
            measurementId: env.measurementId,
        },
        "teleop-lease-server",
    );
    const auth = getAuth(app);
    const db = getDatabase(app);
    const fleetId = env.HELLO_FLEET_ID;
    const signedIn = signInWithEmailAndPassword(
        auth,
        env.roboUsername,
        env.roboPassword,
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

    async function claimLocal(sessionId) {
        const result = await runTransaction(
            await operatorRef(),
            (current) => claimLocalSeat(current, sessionId),
        );
        if (result.committed) {
            try {
                await update(ref(db, `robots/${fleetId}`), {
                    status: "occupied",
                });
            } catch (error) {
                console.error(
                    "Local teleop lease status update failed:",
                    error.message,
                );
            }
        }
        return result.committed;
    }

    async function releaseLocal(sessionId) {
        const seatRef = await operatorRef();
        const current = (await get(seatRef)).val();
        if (
            current?.transport !== "local" ||
            current.sessionId !== sessionId
        ) {
            return false;
        }
        const result = await runTransaction(
            seatRef,
            (current) =>
                releaseLocalSeatTransaction(current, sessionId),
        );
        if (result.committed) {
            await update(ref(db, `robots/${fleetId}`), {
                status: "online",
            });
        }
        return result.committed;
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
