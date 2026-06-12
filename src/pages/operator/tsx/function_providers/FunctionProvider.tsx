import { RemoteRobot } from "shared/remoterobot";
import { VelocityCommand } from "shared/commands";
import { ValidJoints } from "shared/util";
import {
    ActionModeType,
    PilotButtonPadType,
} from "../utils/component_definitions";
import { clampDurationMs } from "../voice/constants";
import { ButtonPadButton } from "./ButtonFunctionProvider";
import { PilotButtonPads } from "../static_components/PilotControlsToggle";

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
    // Used for managing voice-controleld moves since
    // they are inherently *timed* moves, and therefore
    // needed in order to measure movement / stopped.
    public timedVoiceMoveActive = false;
    protected timedVoiceMoveTimer?: ReturnType<typeof setTimeout>;
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

    /**
     * Drive base continuously for durationMs then stop sending velocity.
     * Also, rejects overlapping calls while timedVoiceMoveActive.
     *
     * @returns false if overlap or no RemoteRobot attached
     */
    public timedBaseDrive(
        linVelX: number,
        linVelY: number,
        durationMs: number,
        angVel: number = 0
    ): boolean {
        if (!FunctionProvider.remoteRobot) {
            return false;
        }
        if (this.timedVoiceMoveActive) {
            return false;
        }

        const clampedMs = clampDurationMs(durationMs);

        this.stopCurrentAction(true);
        this.timedVoiceMoveActive = true;
        this.setBaseVelocity(
            linVelX,
            linVelY,
            angVel
        );
        this.timedVoiceMoveTimer = setTimeout(() => {
            this.timedVoiceMoveTimer = undefined;
            this.timedVoiceMoveActive = false;
            this.stopCurrentAction(true);
        }, clampedMs);
        return true;
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
        }, 25);
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

        /**
         * clearTimeout() to prevent the timed voice move
         * from being executed.
         */
        if (this.timedVoiceMoveTimer) {
            clearTimeout(this.timedVoiceMoveTimer);
            this.timedVoiceMoveTimer = undefined;
        }
        this.timedVoiceMoveActive = false;
    }
}
