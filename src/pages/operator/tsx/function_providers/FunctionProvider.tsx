import { Transform } from "roslib";
import { VelocityCommand } from "shared/commands";
import { RemoteRobot } from "shared/remoterobot";
import { RobotPose, ValidJoints } from "shared/util";
import { PilotButtonPads } from "../static_components/PilotControlsToggle";
import {
    ActionModeType,
    PilotButtonPadType,
} from "../utils/component_definitions";
import { ButtonPadButton } from "./ButtonFunctionProvider";

const x = PilotButtonPads;

/**
 * Provides logic to connect the {@link RemoteRobot} and the components in the
 * interface
 */
export abstract class FunctionProvider {
    protected static remoteRobot?: RemoteRobot;
    public static velocityScale: number;
    public static actionMode: ActionModeType;
    public static pilotControlsCurrent: PilotButtonPadType;
    public activeButtonPadFunction: ButtonPadButton;
    public activeVelocityAction?: VelocityCommand;
    public velocityExecutionHeartbeat?: number; // ReturnType<typeof setInterval>
    /**
     * Adds a remote robot instance to this function provider. This must be called
     * before any components of the interface will be able to execute functions
     * to change the state of the robot.
     *
     * @param remoteRobot the remote robot instance to add
     */
    static addRemoteRobot(remoteRobot: RemoteRobot) {
        FunctionProvider.remoteRobot = remoteRobot;
    }

    /**
     * Subscribe to map pose (amcl) updates from the remote robot.
     * Returns a no-op unsubscribe when the robot is not connected yet.
     */
    static subscribeMapPose(
        listener: (pose: Transform) => void,
    ): (() => void) | undefined {
        if (!FunctionProvider.remoteRobot) {
            return undefined;
        }
        return FunctionProvider.remoteRobot.addMapPoseListener(listener);
    }

    /** Latest cached map pose, if the remote robot is connected. */
    static getMapPose(): Transform | undefined {
        return FunctionProvider.remoteRobot?.getMapPose();
    }

    /**
     * Sets the initial values for the velocity scale, action mode, and pilot controls
     *
     * @param velocityScale initial velocity scale
     * @param actionMode initial action mode
     * @param pilotControlsCurrent initial pilot controls current value
     */
    static initialize(
        velocityScale: number,
        actionMode: ActionModeType,
        pilotControlsCurrent: PilotButtonPadType
    ) {
        this.velocityScale = velocityScale;
        this.actionMode = actionMode;
        this.pilotControlsCurrent = pilotControlsCurrent as PilotButtonPadType ?? PilotButtonPads[0];
    }

    /**
     * Check if robot is connected
     */
    public static robotIsConnected(): boolean {
        return FunctionProvider.remoteRobot !== undefined;
    }

    public isMotionActive(): boolean {
        return (
            this.velocityExecutionHeartbeat !== undefined ||
            this.activeVelocityAction !== undefined
        );
    }

    /**
     * Move the robot to an absolute pose (e.g. a voice macro).
     * Stops any ongoing velocity or timed move, then sends a setRobotPose command.
     *
     * @param pose  Partial RobotPose mapping joint names to absolute target positions.
     * @returns false if no robot is connected.
     */
    public executeAbsolutePose(pose: RobotPose): boolean {
        if (!FunctionProvider.remoteRobot) return false;
        this.stopCurrentAction(true);
        FunctionProvider.remoteRobot.setRobotPose(pose);
        return true;
    }

    public setBaseVelocity(linVelX: number, linVelY: number, angVel: number) {
        this.stopCurrentAction();
        this.velocityExecutionHeartbeat = window.setInterval(() => {
            this.activeVelocityAction = FunctionProvider.remoteRobot?.driveBase(
                linVelX,
                linVelY,
                angVel
            );
        }, 25);
    }

    public incrementalJointMovement(jointName: ValidJoints, velocity: number) {
        this.stopCurrentAction(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot?.setJointVelocity(jointName, velocity);
    }

    public continuousJointMovement(jointName: ValidJoints, velocity: number) {
        this.stopCurrentAction();
        this.velocityExecutionHeartbeat = window.setInterval(() => {
            this.activeVelocityAction =
                FunctionProvider.remoteRobot?.setJointVelocity(
                    jointName,
                    velocity
                );
        }, 50);
    }



    /**
     * Move a joint incrementally using the trajectory action server.
     * Stops any ongoing velocity or trajectory action first.
     *
     * @param jointName the joint to actuate
     * @param increment the incremental distance/rotation (m or rad)
     * @returns false if no robot attached
     */
    public incrementalJointMove(
        jointName: ValidJoints,
        increment: number,
    ): boolean {
        if (!FunctionProvider.remoteRobot) {
            return false;
        }

        this.stopCurrentAction(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot.incrementalMove(jointName, increment);
        return true;
    }

    // NOTE: When we undo this temp fix (of not stopping the
    // trajectory client) we also need to undo it in robot.jsx
    // `stopExecution()`.
    public stopCurrentAction(send_stop_command: boolean = false) {
        // if (send_stop_command) FunctionProvider.remoteRobot?.stopTrajectory();
        if (this.activeVelocityAction) {
            // TODO: this.activeVelocityAction.stop sometimes (always?) executes the
            // exact same cancellation command(s) as FunctionProvider.remoteRobot?.stopTrajectory,
            // which means we are unnecessarily calling it twice.
            if (send_stop_command) this.activeVelocityAction.stop();
            this.activeVelocityAction = undefined;
        }

        if (this.velocityExecutionHeartbeat) {
            clearInterval(this.velocityExecutionHeartbeat);
            this.velocityExecutionHeartbeat = undefined;
        }

    }
}
