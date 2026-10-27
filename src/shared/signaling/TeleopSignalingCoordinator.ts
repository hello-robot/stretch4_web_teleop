import { FirebaseOptions } from "firebase/app";
import { SignallingMessage } from "shared/util";
import { FirebaseSignaling } from "./FirebaseSignaling";
import { LocalSignaling } from "./LocalSignaling";
import { BaseSignaling, SignalingProps } from "./Signaling";
const {
    createSignalingTransportGate,
} = require("./signalingTransportGate");

type SignalingTransport = "local" | "firebase";

export class TeleopSignalingCoordinator extends BaseSignaling {
    /** Spacing between background retries of the Firebase join. */
    private static readonly FIREBASE_RETRY_MS = 30000;

    private transportGate = createSignalingTransportGate();
    private pendingTransport: SignalingTransport | null = null;
    private localJoined = false;
    private firebaseJoined = false;
    /** Resolves true once Firebase is configured, false once it has given up. */
    private firebaseReady: Promise<boolean> = Promise.resolve(false);
    private firebaseJoinPending = false;
    private firebaseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by leave() so a retry in flight cannot revive a stale session. */
    private joinEpoch = 0;
    private local: LocalSignaling;
    private firebase: FirebaseSignaling;

    constructor(props: SignalingProps, config: FirebaseOptions) {
        super(props);
        this.local = new LocalSignaling(
            this.transportProps("local"),
        );
        this.firebase = new FirebaseSignaling(
            this.transportProps("firebase"),
            config,
        );
    }

    private transportProps(transport: SignalingTransport): SignalingProps {
        return {
            role: "robot",
            onSignal: (signal) => {
                if (this.transportGate.accepts(transport)) {
                    this.onSignal(signal);
                }
            },
            onRobotConnectionStart: () => {
                if (!this.transportGate.activate(transport)) {
                    this.pendingTransport = transport;
                    console.warn(
                        `Ignoring ${transport} operator while another transport is active`,
                    );
                    return;
                }
                this.pendingTransport = null;
                this.onRobotConnectionStart?.();
            },
            onGoodbye: () => {
                if (!this.transportGate.goodbye(transport)) return;
                this.onGoodbye?.();
                const pendingTransport = this.pendingTransport;
                this.pendingTransport = null;
                if (
                    pendingTransport &&
                    this.transportGate.activate(pendingTransport)
                ) {
                    this.onRobotConnectionStart?.();
                }
            },
        };
    }

    /**
     * Configure both transports. Local signaling is the one this robot can
     * always offer, so the returned promise tracks local alone. Firebase is
     * configured alongside it and a failure there is recorded, never
     * propagated: the caller awaits this before joining any room, and the
     * cloud being unreachable must not cost the robot its local teleop.
     *
     * @param roomName Signaling room to configure on both transports.
     *
     * @returns A promise that settles with the local transport.
     */
    public configure(roomName: string): Promise<void> {
        this.firebaseReady = this.firebase
            .configure(roomName)
            .then(() => true)
            .catch((error) => {
                console.error(
                    "Firebase signaling unavailable; local teleop continues:",
                    error,
                );
                return false;
            });
        return this.local.configure(roomName);
    }

    /**
     * Join as the robot, reporting the local join alone. The robot page loops
     * on this result until it is true, so gating it on Firebase would leave a
     * robot with no teleop at all whenever the cloud is unreachable. The
     * Firebase join runs in the background and retries on its own.
     *
     * @returns True once the local transport has joined its room.
     */
    public join_as_robot(): Promise<boolean> {
        this.joinFirebaseInBackground();
        if (this.localJoined) {
            return Promise.resolve(true);
        }
        return this.local.join_as_robot().then((joined) => {
            this.localJoined = joined;
            return joined;
        });
    }

    /**
     * Attempt the Firebase join once configure settles, retrying on failure.
     *
     * A configure that failed is terminal for this page -- re-running it would
     * stack a second set of database listeners -- so only a join that failed
     * on its own is tried again.
     */
    private joinFirebaseInBackground(): void {
        if (this.firebaseJoined || this.firebaseJoinPending) return;
        this.firebaseJoinPending = true;
        const epoch = this.joinEpoch;
        this.firebaseReady
            .then((ready) => (ready ? this.firebase.join_as_robot() : false))
            .catch((error) => {
                console.error(
                    "Firebase robot join failed; local teleop continues:",
                    error,
                );
                return false;
            })
            .then((joined) => {
                this.firebaseJoinPending = false;
                if (epoch !== this.joinEpoch) return;
                this.firebaseJoined = joined;
                if (joined) return;
                this.firebaseReady.then((ready) => {
                    if (!ready || epoch !== this.joinEpoch) return;
                    this.firebaseRetryTimer = setTimeout(() => {
                        this.firebaseRetryTimer = null;
                        this.joinFirebaseInBackground();
                    }, TeleopSignalingCoordinator.FIREBASE_RETRY_MS);
                });
            });
    }

    public join_as_operator(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public leave(): void {
        this.joinEpoch += 1;
        if (this.firebaseRetryTimer) {
            clearTimeout(this.firebaseRetryTimer);
            this.firebaseRetryTimer = null;
        }
        this.transportGate.reset();
        this.pendingTransport = null;
        this.localJoined = false;
        this.firebaseJoined = false;
        this.local.leave();
        this.firebase.leave();
    }

    public send(signal: SignallingMessage): void {
        if (this.transportGate.accepts("local")) {
            this.local.send(signal);
        } else if (this.transportGate.accepts("firebase")) {
            this.firebase.send(signal);
        }
    }
}
