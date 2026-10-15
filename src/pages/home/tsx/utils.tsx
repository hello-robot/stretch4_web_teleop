import { FirebaseOptions } from "firebase/app";
import { FirebaseLoginHandler } from "./login_handler/FirebaseLoginHandler";
import { LocalLoginHandler } from "./login_handler/LocalLoginHandler";

/**
 * Creates a login handler based on the `storage` property in the process
 * environment.
 *
 * @returns the login handler
 */
export function createLoginHandler(loginHandlerReadyCallback: () => void) {
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
            return new FirebaseLoginHandler(loginHandlerReadyCallback, config);
        default:
            return new LocalLoginHandler(loginHandlerReadyCallback);
    }
}
