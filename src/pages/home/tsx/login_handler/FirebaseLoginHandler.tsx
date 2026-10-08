import { FirebaseOptions, initializeApp } from "firebase/app";
import {
    Auth,
    browserLocalPersistence,
    confirmPasswordReset,
    getAuth,
    GoogleAuthProvider,
    onAuthStateChanged,
    sendPasswordResetEmail,
    setPersistence,
    signInWithEmailAndPassword,
    signInWithPopup,
    signOut,
    verifyPasswordResetCode,
} from "firebase/auth";
import {
    Database,
    get,
    getDatabase,
    onValue,
    ref,
    set,
    update,
} from "firebase/database";
import { aliasInitials } from "../gravatar";
import { OperatorSeat } from "../robotModel";
import { LoginHandler, RobotRooms } from "./LoginHandler";
const {
    reconcileAssignmentRecords,
} = require("./robotAssignmentState");

export class FirebaseLoginHandler extends LoginHandler {
    private auth: Auth;
    private _loginState: string;
    private db: Database;
    private uid: string;
    private alias: string;

    constructor(
        onLoginHandlerReadyCallback: () => void,
        config: FirebaseOptions,
    ) {
        super(onLoginHandlerReadyCallback);
        this._loginState = "not_authenticated";
        const app = initializeApp(config);
        this.auth = getAuth(app);
        this.db = getDatabase(app);

        onAuthStateChanged(this.auth, (user) => {
            this.uid = user ? user.uid : undefined;
            this._loginState = user ? "authenticated" : "not_authenticated";
            if (user) {
                console.log("[LOGIN] Logged in user UID:", user.uid);
                get(ref(this.db, "uids/" + user.uid)).then((snapshot) => {
                    this.alias = snapshot.val() || user.uid;
                    this.onReadyCallback();
                }).catch((err) => {
                    console.error("Failed to resolve alias on login", err);
                    this.alias = user.uid;
                    this.onReadyCallback();
                });
            } else {
                this.alias = undefined;
                this.onReadyCallback();
            }
        });
    }



    public loginState(): string {
        return this._loginState;
    }

    public getUserEmail(): string | undefined {
        return this.auth.currentUser?.email ?? undefined;
    }

    public getUserUid(): string | undefined {
        return this.uid;
    }

    public watchOperatorSeat(
        robotAuthUid: string,
        onSeat: (seat: OperatorSeat | null) => void,
    ): () => void {
        if (!robotAuthUid) {
            onSeat(null);
            return () => {};
        }
        const stopSeat = onValue(ref(this.db, `rooms/${robotAuthUid}/operator`), (snap) => {
            const seat = snap.val();
            if (!seat || seat.active !== true || !seat.uid) {
                onSeat(null);
                return;
            }
            const occupantUid = String(seat.uid);
            const occupantAlias =
                typeof seat.alias === "string" ? seat.alias : "";
            onSeat({
                uid: occupantUid,
                initials: occupantAlias
                    ? aliasInitials(occupantAlias)
                    : undefined,
                email:
                    typeof seat.email === "string" && seat.email.length > 0
                        ? seat.email
                        : undefined,
            });
        });
        return stopSeat;
    }

    public listRooms(
        resultCallback: (robots: RobotRooms) => void,
    ): () => void {
        if (this.alias === undefined) {
            throw new Error(
                "FirebaseLoginHandler.listRooms(): this.alias is null",
            );
        }

        console.log("[listRooms] Resolved alias:", this.alias);
        console.log("[listRooms] Querying: assignments/" + this.alias + "/robots");
        const records: RobotRooms = {};
        const robotStops = new Map<string, () => void>();
        let currentAssignments: Record<string, unknown> = {};
        const emitSnapshot = () => resultCallback({ ...records });
        const stopAssignments = onValue(
            ref(this.db, "assignments/" + this.alias + "/robots"),
            (snapshot) => {
                const assignments = snapshot.val() || {};
                currentAssignments = assignments;
                console.log("[listRooms] Assignments robots result:", assignments);
                const assignedIds = new Set(Object.keys(assignments));

                for (const [robotId, stopRobot] of robotStops) {
                    if (assignedIds.has(robotId)) continue;
                    stopRobot();
                    robotStops.delete(robotId);
                    delete records[robotId];
                }

                const reconciled = reconcileAssignmentRecords(
                    records,
                    assignments,
                );
                Object.keys(records).forEach((robotId) => delete records[robotId]);
                Object.assign(records, reconciled);
                emitSnapshot();

                if (assignedIds.size === 0) {
                    console.warn("[listRooms] No robots found under assignments/" + this.alias + "/robots");
                    return;
                }

                for (const robotId of assignedIds) {
                    if (robotStops.has(robotId)) continue;
                    console.log("[listRooms] Querying: robots/" + robotId);
                    const stopRobot = onValue(
                        ref(this.db, "robots/" + robotId),
                        (robotSnapshot) => {
                            const robotInfo =
                                robotSnapshot.val() || {
                                    name: robotId,
                                    status: "offline",
                                };
                            console.log(
                                "[listRooms] Robot info for " + robotId + ":",
                                robotInfo,
                            );
                            records[robotId] = {
                                ...robotInfo,
                                is_active: Boolean(currentAssignments[robotId]),
                            };
                            emitSnapshot();
                        },
                        (err) => {
                            console.error(
                                "[listRooms] Error reading robots/" + robotId + ":",
                                err.message,
                            );
                            records[robotId] = {
                                name: robotId,
                                status: "offline",
                                is_active: Boolean(currentAssignments[robotId]),
                            };
                            emitSnapshot();
                        },
                    );
                    robotStops.set(robotId, stopRobot);
                }
            },
            (err) => {
                console.error("[listRooms] Error reading assignments/" + this.alias + "/robots:", err.message);
                for (const stopRobot of robotStops.values()) stopRobot();
                robotStops.clear();
                Object.keys(records).forEach((robotId) => delete records[robotId]);
                emitSnapshot();
            }
        );
        return () => {
            stopAssignments();
            for (const stopRobot of robotStops.values()) stopRobot();
            robotStops.clear();
        };
    }

    public logout(): Promise<undefined> {
        // Tutorial here:
        // https://firebase.google.com/docs/auth/web/password-auth#next_steps

        return new Promise<undefined>((resolve, reject) => {
            signOut(this.auth)
                .then(() => {
                    resolve(undefined);
                })
                .catch(reject);
        });
    }

    public login(username: string, password: string): Promise<undefined> {
        // Tutorial here:
        // https://firebase.google.com/docs/auth/web/start?hl=en#sign_in_existing_users
        // Auth State Persistence tutorial here:
        // https://firebase.google.com/docs/auth/web/auth-state-persistence

        return new Promise<undefined>((resolve, reject) => {
            setPersistence(this.auth, browserLocalPersistence)
                .then(() => {
                    signInWithEmailAndPassword(this.auth, username, password)
                        .then((userCredential) => {
                            resolve(undefined);
                        })
                        .catch(reject);
                })
                .catch(reject);
        });
    }

    public loginWithGoogle(): Promise<undefined> {
        return setPersistence(this.auth, browserLocalPersistence).then(() =>
            signInWithPopup(this.auth, new GoogleAuthProvider()).then(
                () => undefined,
                (error) => {
                    // Closing the popup is a cancel, not a failure.
                    if (error?.code === "auth/popup-closed-by-user") {
                        return undefined;
                    }
                    return Promise.reject(error);
                },
            ),
        );
    }

    public forgot_password(username: string): Promise<undefined> {
        // Tutorial here:
        // https://firebase.google.com/docs/auth/web/manage-users?hl=en#send_a_password_reset_email

        // The link in the email is still Firebase's, until the project's
        // password-reset template uses this origin as its action URL. The
        // continue URL brings the user back here after they save.
        return sendPasswordResetEmail(this.auth, username, {
            url: window.location.origin + "/",
            handleCodeInApp: false,
        }).then(() => undefined);
    }

    public verifyPasswordReset(code: string): Promise<string> {
        return verifyPasswordResetCode(this.auth, code);
    }

    public completePasswordReset(code: string, password: string): Promise<void> {
        return confirmPasswordReset(this.auth, code, password);
    }

    public requestRobotLaunch(robo_uid: string, mapId?: string | null): Promise<void> {
        if (!this.alias) return Promise.reject("User not logged in");
        return set(ref(this.db, "robots/" + robo_uid + "/control"), {
            action: "launch",
            map_id: mapId || null,
            requested_by: this.alias,
            requested_at: Date.now(),
        });
    }

    public setRobotMap(robo_uid: string, mapId: string | null): Promise<void> {
        if (!this.alias) return Promise.reject("User not logged in");
        return set(ref(this.db, "robots/" + robo_uid + "/map_id"), mapId);
    }

    public setRobotConfig(
        robo_uid: string,
        flag: string,
        enabled: boolean,
    ): Promise<void> {
        if (!this.alias) return Promise.reject("User not logged in");
        return update(ref(this.db, "robots/" + robo_uid + "/config"), {
            [flag]: enabled,
        });
    }

    public watchLaunchLog(fleetId: string, onLog: (text: string) => void): () => void {
        if (!this.db || !fleetId) {
            onLog("");
            return () => {};
        }
        return onValue(
            ref(this.db, "launch_logs/" + fleetId),
            (snapshot) => {
                const value = snapshot.val();
                onLog(typeof value === "string" ? value : "");
            },
            () => onLog(""),
        );
    }

    public getUserMaps(robotUid: string, callback: (maps: any) => void): void {
        console.log(`[getUserMaps] Called for robotUid: ${robotUid}, alias: ${this.alias}`);
        if (!this.db) {
            console.warn("[getUserMaps] Database is null. Returning empty.");
            return;
        }
        if (!this.alias) {
            console.warn("[getUserMaps] Alias is null. Returning empty.");
            callback({});
            return;
        }

        console.log(`[getUserMaps] Querying: assignments/${this.alias}/maps`);
        onValue(ref(this.db, "assignments/" + this.alias + "/maps"), (assignedSnapshot) => {
            const aliasMapIds = assignedSnapshot.val() || {};
            console.log(`[getUserMaps] assignments/${this.alias}/maps result:`, aliasMapIds);

            const mapIds = Object.keys(aliasMapIds);
            if (mapIds.length === 0) {
                console.log("[getUserMaps] No maps assigned to alias, falling back to robot maps");
                this.fallbackGetRobotMaps(robotUid, callback);
                return;
            }

            const accessibleMaps = {};
            let loadedCount = 0;

            mapIds.forEach((mapId) => {
                get(ref(this.db, "maps/" + mapId)).then((mapSnap) => {
                    if (mapSnap.exists()) {
                        const mapVal = mapSnap.val();
                        // Security verification: Enforce that only assigned / allowed users can access
                        const isOwner = mapVal.owner_uid === this.alias;
                        const isAllowed = mapVal.allowed_users && mapVal.allowed_users[this.alias];
                        const isExplicitlyAssigned = Boolean(aliasMapIds[mapId]);

                        if (isOwner || isAllowed || isExplicitlyAssigned) {
                            accessibleMaps[mapId] = mapVal;
                        }
                    } else {
                        console.warn(`[getUserMaps] maps/${mapId} does not exist in DB.`);
                        const isExplicitlyAssigned = Boolean(aliasMapIds[mapId]);
                        if (isExplicitlyAssigned) {
                            console.log(`[getUserMaps] Map ${mapId} is explicitly assigned but missing info. Returning name only.`);
                            accessibleMaps[mapId] = { name: mapId };
                        }
                    }
                    loadedCount++;
                    if (loadedCount === mapIds.length) {
                        if (Object.keys(accessibleMaps).length > 0) {
                            console.log(`[getUserMaps] Final accessible maps for alias:`, accessibleMaps);
                            callback(accessibleMaps);
                        } else {
                            console.log("[getUserMaps] No accessible maps found for alias, falling back to robot maps");
                            this.fallbackGetRobotMaps(robotUid, callback);
                        }
                    }
                }).catch((err) => {
                    console.error(`[getUserMaps] Error querying maps/${mapId}:`, err);
                    const isExplicitlyAssigned = Boolean(aliasMapIds[mapId]);
                    if (isExplicitlyAssigned) {
                        console.log(`[getUserMaps] Map ${mapId} is explicitly assigned but had error fetching. Returning name only.`);
                        accessibleMaps[mapId] = { name: mapId };
                    }
                    loadedCount++;
                    if (loadedCount === mapIds.length) {
                        if (Object.keys(accessibleMaps).length > 0) {
                            console.log(`[getUserMaps] Final accessible maps for alias:`, accessibleMaps);
                            callback(accessibleMaps);
                        } else {
                            console.log("[getUserMaps] No accessible maps found for alias, falling back to robot maps");
                            this.fallbackGetRobotMaps(robotUid, callback);
                        }
                    }
                });
            });
        }, (err) => {
            console.error(`[getUserMaps] Error querying assignments/${this.alias}/maps:`, err);
            this.fallbackGetRobotMaps(robotUid, callback);
        });
    }

    private fallbackGetRobotMaps(robotUid: string, callback: (maps: any) => void): void {
        console.log(`[fallbackGetRobotMaps] Called for robotUid: ${robotUid}`);
        if (!robotUid) {
            console.warn("[fallbackGetRobotMaps] robotUid is null. Returning empty.");
            callback({});
            return;
        }

        console.log(`[fallbackGetRobotMaps] Querying: assignments/${robotUid}/maps`);
        onValue(ref(this.db, "assignments/" + robotUid + "/maps"), (snapshot) => {
            const assignedMapIds = snapshot.val() || {};
            console.log(`[fallbackGetRobotMaps] assignments/${robotUid}/maps result:`, assignedMapIds);
            const mapIds = Object.keys(assignedMapIds);

            if (mapIds.length === 0) {
                console.log("[fallbackGetRobotMaps] No maps assigned to robot");
                callback({});
                return;
            }

            const accessibleMaps = {};
            let loadedCount = 0;

            mapIds.forEach((mapId) => {
                console.log(`[fallbackGetRobotMaps] Querying: maps/${mapId}`);
                get(ref(this.db, "maps/" + mapId)).then((mapSnap) => {
                    if (mapSnap.exists()) {
                        const mapVal = mapSnap.val();
                        console.log(`[fallbackGetRobotMaps] maps/${mapId} result:`, mapVal);
                        const isOwner = mapVal.owner_uid === this.alias;
                        const isAllowed = mapVal.allowed_users &&
                            (mapVal.allowed_users[this.alias] || mapVal.allowed_users[robotUid]);

                        if (isOwner || isAllowed) {
                            accessibleMaps[mapId] = mapVal;
                        }
                    } else {
                        console.warn(`[fallbackGetRobotMaps] maps/${mapId} does not exist in DB.`);
                    }
                    loadedCount++;
                    if (loadedCount === mapIds.length) {
                        console.log(`[fallbackGetRobotMaps] Final accessible maps for robot:`, accessibleMaps);
                        callback(accessibleMaps);
                    }
                }).catch((err) => {
                    console.error(`[fallbackGetRobotMaps] Error querying maps/${mapId}:`, err);
                    loadedCount++;
                    if (loadedCount === mapIds.length) {
                        console.log(`[fallbackGetRobotMaps] Final accessible maps for robot:`, accessibleMaps);
                        callback(accessibleMaps);
                    }
                });
            });
        }, (err) => {
            console.error("[fallbackGetRobotMaps] Error reading assignments for robot:", err.message);
            callback({});
        });
    }

    public requestRobotStop(robo_uid: string): Promise<void> {
        if (!this.alias) return Promise.reject("User not logged in");
        return set(ref(this.db, "robots/" + robo_uid + "/control"), {
            action: "stop",
            requested_by: this.alias,
            requested_at: Date.now(),
        });
    }
}
