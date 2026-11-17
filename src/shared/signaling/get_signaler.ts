import { FirebaseOptions } from "firebase/app";
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
                apiKey: process.env.PUBLIC_FIREBASE_API_KEY,
                authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
                databaseURL: process.env.PUBLIC_FIREBASE_DATABASE_URL,
                projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID,
                storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
                messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
                appId: process.env.PUBLIC_FIREBASE_APP_ID,
                measurementId: process.env.PUBLIC_FIREBASE_MEASUREMENT_ID,
            };
            // An operator gets a single transport, fixed by the bundle it
            // loaded, which is fixed by the URL it opened. The robot peer
            // (start_robot_peer.py) listens on both when the cloud door is open.
            return new FirebaseSignaling(props, config);
        default:
            return new LocalSignaling(props);
    }
}
