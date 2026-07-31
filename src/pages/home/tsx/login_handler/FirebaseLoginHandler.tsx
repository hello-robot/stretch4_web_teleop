import { LoginHandler } from "./LoginHandler";
import { initializeApp, FirebaseOptions } from "firebase/app";
import {
    getAuth,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signOut,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    Auth,
} from "firebase/auth";
import { getDatabase, ref, onValue, set, Database } from "firebase/database";

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

        onValue(
            ref(this.db, "assignments/" + this.uid + "/robots"),
            (snapshot) => {
                let robots = snapshot.val();
                Object.entries(robots).forEach(([robo_uid, is_active]) => {
                    onValue(ref(this.db, "robots/" + robo_uid), (snapshot2) => {
                        let robo_info = snapshot2.val();
                        robo_info["is_active"] = is_active;
                        resultCallback(robo_uid, robo_info);
                    });
                });
            },
        );
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
