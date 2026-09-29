import { SignallingMessage } from "shared/util";

export interface SignalingProps {
    onSignal: (SignallingMessage) => void;
    onGoodbye?: () => void;
    onRobotConnectionStart?: () => void;
    role?: string;
}

export abstract class BaseSignaling {
    public onSignal: (SignallingMessage) => void;
    public onGoodbye?: () => void;
    public onRobotConnectionStart?: () => void;
    public initialRole?: string;

    constructor(props: SignalingProps) {
        this.onSignal = props.onSignal;
        this.onGoodbye = props.onGoodbye;
        this.onRobotConnectionStart = props.onRobotConnectionStart;
        this.initialRole = props.role;
    }

    public abstract configure(room_name: string): Promise<void>;

    /**
     * Joins the signaling room as a robot
     */
    public abstract join_as_robot(): Promise<boolean>;

    /**
     * Joins the signaling room as an operator
     */
    public abstract join_as_operator(): Promise<boolean>;

    /**
     * Leaves the signaling room
     */
    public abstract leave(): void;

    /**
     * Send offer and meta info to peer
     */
    public abstract send(signal: SignallingMessage): void;
}
