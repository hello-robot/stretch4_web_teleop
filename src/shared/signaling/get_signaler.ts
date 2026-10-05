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

declare global {
    interface Window {
        __STRETCH_ROBOT_FIREBASE_AUTH__?: Readonly<{
            username: string;
            password: string;
        }>;
    }
}

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
 * The trusted local Playwright launcher injects credentials into this one page
 * before any bundle code runs. Hosted or manually opened robot pages fail
 * closed because they do not have that injected value.
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
        const credentials = window.__STRETCH_ROBOT_FIREBASE_AUTH__;
        delete window.__STRETCH_ROBOT_FIREBASE_AUTH__;

        return new Promise<void>((resolve, reject) => {
            if (!credentials?.username || !credentials.password) {
                console.error("Missing trusted local robot authentication");
                reject(new Error("Missing trusted local robot authentication"));
                return;
            }

            setPersistence(auth, inMemoryPersistence)
                .then(() => {
                    signInWithEmailAndPassword(
                        auth,
                        credentials.username,
                        credentials.password,
                    )
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
