import { initializeApp, FirebaseOptions } from "firebase/app";
import {
    getAuth,
    signInWithEmailAndPassword,
    setPersistence,
    inMemoryPersistence,
    Auth,
} from "firebase/auth";
import { FirebaseSignaling } from "./FirebaseSignaling";
import { LocalSignaling } from "./LocalSignaling";
import { SignalingProps } from "./Signaling";

/**
 * Creates a signaling handler based on the `storage` property in the process
 * environment.
 *
 * @returns the signaler
 */
export function createSignaler(props: SignalingProps) {
    switch (process.env.storage) {
        case "firebase":
            const config: FirebaseOptions = {
                apiKey: process.env.apiKey,
                authDomain: process.env.authDomain,
                databaseURL: process.env.databaseURL,
                projectId: process.env.projectId,
                storageBucket: process.env.storageBucket,
                messagingSenderId: process.env.messagingSenderId,
                appId: process.env.appId,
                measurementId: process.env.measurementId,
            };
            return new FirebaseSignaling(props, config);
        default:
            return new LocalSignaling(props);
    }
}

/**
 * If using Firebase for signaling, this method logs the robot into its account.
 * This method is meant to be used by the robot browser. In addition to the
 * Firebase config, the `roboUsername` and `roboPassword` env vars must be set.
 */
export function loginFirebaseSignalerAsRobot() {
    if (process.env.storage === "firebase") {
        const config: FirebaseOptions = {
            apiKey: process.env.apiKey,
            authDomain: process.env.authDomain,
            databaseURL: process.env.databaseURL,
            projectId: process.env.projectId,
            storageBucket: process.env.storageBucket,
            messagingSenderId: process.env.messagingSenderId,
            appId: process.env.appId,
            measurementId: process.env.measurementId,
        };
        const app = initializeApp(config);
        let auth: Auth = getAuth(app);
        return new Promise<void>((resolve, reject) => {
            const urlParams = new URLSearchParams(window.location.search);
            const user = urlParams.get('user') || process.env.roboUsername;
            const pass = urlParams.get('pass') || process.env.roboPassword;

            if (!user || !pass) {
                console.error("Missing robot credentials (roboUsername/roboPassword)");
                reject(new Error("Missing robot credentials"));
                return;
            }

            setPersistence(auth, inMemoryPersistence)
                .then(() => {
                    signInWithEmailAndPassword(auth, user, pass)
                        .then((userCredential) => {
                            resolve();
                        })
                        .catch(reject);
                })
                .catch(reject);
        });
    } else {
        return new Promise<void>((resolve) => {
            resolve();
        });
    }
}
