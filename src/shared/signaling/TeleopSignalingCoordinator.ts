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
    private transportGate = createSignalingTransportGate();
    private pendingTransport: SignalingTransport | null = null;
    private localJoined = false;
    private firebaseJoined = false;
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

    public configure(roomName: string): Promise<void> {
        return Promise.all([
            this.local.configure(roomName),
            this.firebase.configure(roomName),
        ]).then(() => undefined);
    }

    public join_as_robot(): Promise<boolean> {
        return Promise.all([
            this.localJoined
                ? Promise.resolve(true)
                : this.local.join_as_robot(),
            this.firebaseJoined
                ? Promise.resolve(true)
                : this.firebase.join_as_robot(),
        ]).then(([localJoined, firebaseJoined]) => {
            this.localJoined = this.localJoined || localJoined;
            this.firebaseJoined = this.firebaseJoined || firebaseJoined;
            return this.localJoined && this.firebaseJoined;
        });
    }

    public join_as_operator(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public leave(): void {
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
