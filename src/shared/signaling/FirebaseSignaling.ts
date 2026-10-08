import { SignallingMessage } from "shared/util";
import {
    firebaseSeatBlock,
    firebaseSeatHeldByOther,
    OPERATOR_SEAT_HEARTBEAT_MS,
    OperatorSeatBlock,
} from "./operatorSeat";
import { BaseSignaling, SignalingProps } from "./Signaling";
import { initializeApp, FirebaseOptions } from "firebase/app";
import { getAuth, onAuthStateChanged, Auth } from "firebase/auth";
import {
    getDatabase,
    ref,
    onValue,
    get,
    set,
    update,
    onDisconnect,
    runTransaction,
    Database,
} from "firebase/database";

// TODO: use lodash isequal
function isEqual(obj1, obj2) {
    if (!isObject(obj1) || !isObject(obj2)) {
        return obj1 === obj2;
    }
    var props1 = Object.getOwnPropertyNames(obj1);
    var props2 = Object.getOwnPropertyNames(obj2);
    if (props1.length != props2.length) {
        return false;
    }
    for (var i = 0; i < props1.length; i++) {
        let val1 = obj1[props1[i]];
        let val2 = obj2[props1[i]];
        let isObjects = isObject(val1) && isObject(val2);
        if (
            (isObjects && !isEqual(val1, val2)) ||
            (!isObjects && val1 !== val2)
        ) {
            return false;
        }
    }
    return true;
}
function isObject(object) {
    return object != null && typeof object === "object";
}

export class FirebaseSignaling extends BaseSignaling {
    private auth: Auth;
    private _loginState: string;
    private db: Database;
    private uid: string;
    private role: string;
    private robot_name: string;
    private alias: string;
    private prevSignal;
    private room_uid: string;
    private is_joined: boolean;
    /** One browser tab. A second tab or preview channel gets a different id and is rejected. */
    private sessionId = crypto.randomUUID();
    private seatBlock: OperatorSeatBlock | null = null;
    /** Set when this tab explicitly chose Launch to replace its other session. */
    private takeover = false;
    private leaveEpoch = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    private get robot_key(): string {
        return (this.role === "robot" && this.robot_name) ? this.robot_name : this.uid;
    }

    private applyRoomSignal(currSignal) {
        if (!this.is_joined || !currSignal) return;
        const localOperatorLease =
            this.role === "robot" && currSignal.transport === "local";
        const changes = {};
        for (const key in currSignal) {
            if (
                !this.prevSignal ||
                !(key in this.prevSignal) ||
                !isEqual(currSignal[key], this.prevSignal[key])
            ) {
                changes[key] = currSignal[key];
            }
        }
        this.prevSignal = currSignal;

        if (
            localOperatorLease &&
            (Object.keys(changes).includes("active") ||
                Object.keys(changes).includes("transport"))
        ) {
            this.onGoodbye();
            return;
        }

        if (
            !localOperatorLease &&
            (Object.keys(changes).includes("candidate") ||
                Object.keys(changes).includes("sessionDescription") ||
                Object.keys(changes).includes("cameraInfo"))
        ) {
            if (Object.keys(changes).includes("active")) {
                delete changes["active"];
            }
            this.onSignal(changes);
        }
        if (Object.keys(changes).includes("active") && !changes["active"]) {
            console.log("bye");
            if (this.role === "robot") {
                update(ref(this.db, "robots/" + this.robot_key), {
                    status: "online",
                });
            } else {
                this.leave();
            }
            this.onGoodbye();
            return;
        }
        if (
            this.role === "robot" &&
            !localOperatorLease &&
            Object.keys(changes).includes("active") &&
            changes["active"]
        ) {
            console.log(
                `Operator has joined the room. My role: ${this.role}.`,
            );
            update(ref(this.db, "robots/" + this.robot_key), {
                status: "occupied",
            });
            if (this.onRobotConnectionStart) this.onRobotConnectionStart();
        }
    }

    constructor(props: SignalingProps, config: FirebaseOptions) {
        super(props);
        this._loginState = "not_authenticated";
        const app = initializeApp(config);
        this.auth = getAuth(app);
        this.db = getDatabase(app);
    }

    private async _get_room_uid(room_name: string): Promise<string> {
        if (this.role === "robot") {
            return this.uid;
        }
        if (this.role !== "operator") {
            throw new Error("Invalid signaling role");
        }

        const snapshot = await get(
            ref(this.db, "assignments/" + this.alias + "/robots"),
        );
        const robots = snapshot.val() || {};
        for (const [robotKey, isActive] of Object.entries(robots)) {
            if (!isActive) continue;
            const robotSnapshot = await get(
                ref(this.db, "robots/" + robotKey),
            );
            const robotInfo = robotSnapshot.val();
            if (
                robotInfo &&
                (robotInfo.name || robotKey) === room_name &&
                robotInfo.uid
            ) {
                return robotInfo.uid;
            }
        }
        throw new Error(`Robot room is not assigned: ${room_name}`);
    }

    public configure(room_name: string): Promise<void> {
        console.log("FirebaseSignaling: configure() called with room_name:", room_name);
        return new Promise<void>((resolve, reject) => {
            // wait to be authenticated
            onAuthStateChanged(this.auth, (user) => {
                console.log("FirebaseSignaling: onAuthStateChanged event triggered. User UID:", user ? user.uid : "null");
                this.uid = user ? user.uid : undefined;
                this._loginState = user ? "authenticated" : "not_authenticated";

                if (this._loginState === "authenticated") {
                    if (this.initialRole === "robot") {
                        const urlParams = new URLSearchParams(window.location.search);
                        const requestedFleetId =
                            urlParams.get("fleet_id") ||
                            process.env.HELLO_FLEET_ID;
                        get(
                            ref(
                                this.db,
                                "assignments/" + this.uid,
                            ),
                        ).then((assignmentSnapshot) => {
                            const assignment = assignmentSnapshot.val();
                            if (
                                !assignment ||
                                assignment.role !== "robot" ||
                                typeof assignment.name !== "string" ||
                                assignment.name !== requestedFleetId
                            ) {
                                throw new Error(
                                    "Robot account is not provisioned for this fleet",
                                );
                            }
                            this.alias = this.uid;
                            this.role = "robot";
                            this.robot_name = assignment.name;
                            console.log(
                                `FirebaseSignaling: verified robot ${this.robot_name}`,
                            );

                            return this._get_room_uid(room_name);
                        }).then((room_uid) => {
                            this.room_uid = room_uid;
                            let opposite_role = "operator";
                            console.log("FirebaseSignaling: room_uid is:", this.room_uid, ". Listening to rooms/" + this.room_uid + "/" + opposite_role);
                            onValue(
                                ref(
                                    this.db,
                                    "rooms/" +
                                        this.room_uid +
                                        "/" +
                                        opposite_role,
                                ),
                                (snapshot) => {
                                    this.applyRoomSignal(snapshot.val());
                                },
                            );

                            resolve();
                        }).catch((error) => {
                            console.error(
                                "FirebaseSignaling: robot identity verification failed:",
                                error,
                            );
                            reject(error);
                        });
                        return;
                    }

                    console.log("FirebaseSignaling: authenticated. Querying uids/" + this.uid);
                    get(ref(this.db, "uids/" + this.uid)).then((uidSnapshot) => {
                        const alias = uidSnapshot.val() || this.uid;
                        this.alias = alias;
                        console.log("FirebaseSignaling: fetched alias:", alias, ". Querying assignments/" + alias);
                        get(ref(this.db, "assignments/" + alias)).then(
                            (snapshot) => {
                                const assignment = snapshot.val() || {};
                                console.log("FirebaseSignaling: fetched assignment:", assignment);
                                if (
                                    assignment.role &&
                                    assignment.role !== this.initialRole
                                ) {
                                    throw new Error(
                                        "Configured signaling role does not match this client",
                                    );
                                }
                                this.role = this.initialRole;
                                this.robot_name = assignment.name;

                                const continueConfigure = () => {
                                    console.log(`My role: ${this.role}, My name: ${this.robot_name}`);
                                    if (!["robot", "operator"].includes(this.role)) {
                                        console.error("ERROR: invalid role");
                                        throw new Error("Invalid role");
                                    }

                                    this._get_room_uid(room_name).then((room_uid) => {
                                        this.room_uid = room_uid;
                                        if (this.role === "operator") {
                                            onValue(
                                                ref(this.db, "rooms/" + this.room_uid + "/operator"),
                                                (seatSnap) => {
                                                    const seat = seatSnap.val();
                                                    const displaced =
                                                        seat?.active === true &&
                                                        seat.sessionId !== this.sessionId;
                                                    if (
                                                        this.is_joined &&
                                                        (!seat ||
                                                            seat.active === false ||
                                                            displaced)
                                                    ) {
                                                        console.log(
                                                            displaced
                                                                ? "Operator seat replaced by another session"
                                                                : "Operator seat cleared",
                                                        );
                                                        this.stopSeatHeartbeat();
                                                        onDisconnect(
                                                            ref(
                                                                this.db,
                                                                "rooms/" +
                                                                    this.room_uid +
                                                                    "/operator",
                                                            ),
                                                        ).cancel();
                                                        this.is_joined = false;
                                                        this.leaveEpoch += 1;
                                                        if (displaced && this.onOperatorDisplaced) {
                                                            this.onOperatorDisplaced();
                                                        } else {
                                                            this.onGoodbye();
                                                        }
                                                    }
                                                },
                                            );
                                        }
                                        let opposite_role =
                                            this.role === "robot"
                                                ? "operator"
                                                : "robot";
                                        console.log("FirebaseSignaling: room_uid is:", this.room_uid, ". Listening to rooms/" + this.room_uid + "/" + opposite_role);
                                        onValue(
                                            ref(
                                                this.db,
                                                "rooms/" +
                                                    this.room_uid +
                                                    "/" +
                                                    opposite_role,
                                            ),
                                            (snapshot) => {
                                                this.applyRoomSignal(snapshot.val());
                                            },
                                        );

                                        resolve();
                                    }).catch(reject);
                                };

                                continueConfigure();
                            },
                        ).catch((err) => {
                            console.error("FirebaseSignaling: Error fetching assignment:", err);
                            reject(err);
                        });
                    }).catch((err) => {
                        console.error("FirebaseSignaling: Error fetching UID alias:", err);
                        reject(err);
                    });
                }
            });
        });
    }

    private claimRoomSlot(): Promise<void> {
        const slotRef = ref(
            this.db,
            "rooms/" + this.room_uid + "/" + this.role,
        );
        // Tab close / refresh often skips leave(); clear the seat when Firebase drops us.
        onDisconnect(slotRef).set({ active: false });
        return set(slotRef, {
            active: true,
            uid: this.uid || null,
        }).then(() => {
            this.is_joined = true;
        });
    }

    public join_as_robot(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            // onwindowunload is flaky. is_active might stay true when the robot
            // browser exits, so we always reclaim this seat.
            this.claimRoomSlot().then(() => {
                update(ref(this.db, "robots/" + this.robot_key), {
                    status: "online",
                });
                resolve(true);
            });
        });
    }

    public operatorJoinBlocked(): boolean {
        return this.seatBlock !== null;
    }

    public operatorJoinBlock(): OperatorSeatBlock | null {
        return this.seatBlock;
    }

    public requestOperatorTakeover(): void {
        this.takeover = true;
    }

    private operatorRelease() {
        return {
            active: false,
            transport: "firebase",
            uid: this.uid,
            alias: this.alias || this.uid,
            sessionId: this.sessionId,
            claimedAt: Date.now(),
        };
    }

    private stopSeatHeartbeat() {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private startSeatHeartbeat() {
        this.stopSeatHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.is_joined || this.role !== "operator" || !this.room_uid) {
                return;
            }
            update(ref(this.db, "rooms/" + this.room_uid + "/operator"), {
                claimedAt: Date.now(),
            });
        }, OPERATOR_SEAT_HEARTBEAT_MS);
    }

    /**
     * One live operator for this robot. A fresh firebase seat stays exclusive
     * even for the same account. A missing or stale claimedAt can be taken by
     * anyone assigned to the robot. An active local seat stays exclusive.
     */
    private async claimOperatorSeat(): Promise<boolean> {
        const slotRef = ref(this.db, "rooms/" + this.room_uid + "/operator");
        const result = await runTransaction(slotRef, (current) => {
            if (
                firebaseSeatHeldByOther(
                    current,
                    this.uid,
                    this.sessionId,
                    Date.now(),
                    this.takeover,
                )
            ) {
                return;
            }
            return {
                active: true,
                transport: "firebase",
                uid: this.uid || null,
                alias: this.alias || this.uid || null,
                sessionId: this.sessionId,
                claimedAt: Date.now(),
            };
        });
        if (!result.committed) {
            const block = firebaseSeatBlock(
                result.snapshot.val(),
                this.uid,
                this.sessionId,
                Date.now(),
                this.takeover,
            );
            this.seatBlock = block ?? "other";
            if (this.seatBlock !== "same-account") {
                console.log("Another operator is already active");
            }
            return false;
        }
        this.seatBlock = null;
        onDisconnect(slotRef).set(this.operatorRelease());
        this.leaveEpoch += 1;
        this.is_joined = true;
        this.startSeatHeartbeat();
        return true;
    }

    public join_as_operator(): Promise<boolean> {
        this.seatBlock = null;
        return new Promise<boolean>((resolve) => {
            get(ref(this.db, "rooms/" + this.room_uid + "/robot/active"))
                .then((snapshot) => {
                    if (!snapshot.val()) {
                        console.log("Robot is not active");
                        resolve(false);
                        return;
                    }
                    return this.claimOperatorSeat().then((claimed) => {
                        resolve(claimed);
                    });
                })
                .catch((err) => {
                    console.error("FirebaseSignaling: operator join failed", err);
                    resolve(false);
                });
        });
    }

    public leave(): void {
        if (!this.room_uid || !this.role || !this.is_joined) {
            return;
        }
        this.is_joined = false;
        this.stopSeatHeartbeat();
        const epoch = ++this.leaveEpoch;
        console.log(`Leaving. My role: ${this.role}.`);
        const slotRef = ref(
            this.db,
            "rooms/" + this.room_uid + "/" + this.role,
        );
        const sessionId = this.sessionId;
        const release =
            this.role === "operator"
                ? this.operatorRelease()
                : { active: false };
        // Keep onDisconnect armed until the release lands. A tab close often
        // dies before this write finishes; the queued disconnect still clears us.
        runTransaction(slotRef, (current) => {
            if (this.leaveEpoch !== epoch || this.is_joined) return;
            if (this.role === "operator") {
                if (!current || current.sessionId !== sessionId) return;
            }
            return release;
        }).then((result) => {
            if (result.committed && this.leaveEpoch === epoch && !this.is_joined) {
                onDisconnect(slotRef).cancel();
            }
        }).catch((err) => {
            console.error("FirebaseSignaling: leave failed", err);
        });
        if (this.role === "robot") {
            update(ref(this.db, "robots/" + this.robot_key), {
                status: "offline",
            });
        }
    }

    public send(signal: SignallingMessage): void {
        if (this.is_joined) {
            let sanitizedSignal: any = {};
            if (signal.sessionDescription) {
                sanitizedSignal.sessionDescription =
                    typeof signal.sessionDescription.toJSON === "function"
                        ? signal.sessionDescription.toJSON()
                        : {
                              type: signal.sessionDescription.type,
                              sdp: signal.sessionDescription.sdp,
                          };
            }
            if (signal.candidate) {
                sanitizedSignal.candidate =
                    typeof signal.candidate.toJSON === "function"
                        ? signal.candidate.toJSON()
                        : {
                              candidate: signal.candidate.candidate,
                              sdpMid: signal.candidate.sdpMid,
                              sdpMLineIndex: signal.candidate.sdpMLineIndex,
                              usernameFragment: signal.candidate.usernameFragment,
                          };
            }
            if (signal.cameraInfo) {
                sanitizedSignal.cameraInfo = signal.cameraInfo;
            }

            update(
                ref(this.db, "rooms/" + this.room_uid + "/" + this.role),
                sanitizedSignal,
            );
        }
    }
}
