import { FirebaseOptions, initializeApp } from "firebase/app";
import {
    Auth,
    browserLocalPersistence,
    browserSessionPersistence,
    getAuth,
    onAuthStateChanged,
    sendPasswordResetEmail,
    setPersistence,
    signInWithEmailAndPassword,
    signOut,
} from "firebase/auth";
import { Database, getDatabase, onValue, ref, set } from "firebase/database";
import { LoginHandler } from "./LoginHandler";

export class FirebaseLoginHandler extends LoginHandler {
    private auth: Auth;
    private _loginState: string;
    private db: Database;
    private uid: string;

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
            }
            this.onReadyCallback();
        });
    }

    public loginState(): string {
        return this._loginState;
    }

    public listRooms(resultCallback) {
        if (this.uid === undefined) {
            throw new Error(
                "FirebaseLoginHandler.listRooms(): this.uid is null",
            );
        }

        console.log("[listRooms] Querying: uids/" + this.uid);
        onValue(ref(this.db, "uids/" + this.uid), (uidSnapshot) => {
            const alias = uidSnapshot.val() || this.uid;
            console.log("[listRooms] Resolved alias:", alias);
            console.log("[listRooms] Querying: assignments/" + alias + "/robots");
            onValue(
                ref(this.db, "assignments/" + alias + "/robots"),
                (snapshot) => {
                    let robots = snapshot.val();
                    console.log("[listRooms] Assignments robots result:", robots);
                    if (!robots) {
                        console.warn("[listRooms] No robots found under assignments/" + alias + "/robots");
                        return;
                    }
                    Object.entries(robots).forEach(([robo_uid, is_active]) => {
                        console.log("[listRooms] Querying: robots/" + robo_uid);
                        onValue(ref(this.db, "robots/" + robo_uid), (snapshot2) => {
                            let robo_info = snapshot2.val() || { name: robo_uid, status: "offline" };
                            console.log("[listRooms] Robot info for " + robo_uid + ":", robo_info);
                            robo_info["is_active"] = is_active;
                            resultCallback(robo_uid, robo_info);
                        }, (err) => {
                            console.error("[listRooms] Error reading robots/" + robo_uid + ":", err.message);
                        });
                    });
                },
                (err) => {
                    console.error("[listRooms] Error reading assignments/" + alias + "/robots:", err.message);
                }
            );
        }, (err) => {
            console.error("[listRooms] Error reading uids/" + this.uid + ":", err.message);
        });
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

    public login(
        username: string,
        password: string,
        remember_me: boolean,
    ): Promise<undefined> {
        // Tutorial here:
        // https://firebase.google.com/docs/auth/web/start?hl=en#sign_in_existing_users
        // Auth State Persistence tutorial here:
        // https://firebase.google.com/docs/auth/web/auth-state-persistence

        return new Promise<undefined>((resolve, reject) => {
            setPersistence(
                this.auth,
                remember_me
                    ? browserLocalPersistence
                    : browserSessionPersistence,
            )
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

    public forgot_password(username: string): Promise<undefined> {
        // Tutorial here:
        // https://firebase.google.com/docs/auth/web/manage-users?hl=en#send_a_password_reset_email

        return new Promise<undefined>((resolve, reject) => {
            sendPasswordResetEmail(this.auth, username)
                .then(() => {
                    resolve(undefined);
                })
                .catch(reject);
        });
    }

    public requestRobotLaunch(robo_uid: string): Promise<void> {
        if (!this.uid) return Promise.reject("User not logged in");
        return set(ref(this.db, "robots/" + robo_uid + "/control"), {
            action: "launch",
            requested_by: this.uid,
            requested_at: Date.now(),
        });
    }

    public requestRobotStop(robo_uid: string): Promise<void> {
        if (!this.uid) return Promise.reject("User not logged in");
        return set(ref(this.db, "robots/" + robo_uid + "/control"), {
            action: "stop",
            requested_by: this.uid,
            requested_at: Date.now(),
        });
    }
}
