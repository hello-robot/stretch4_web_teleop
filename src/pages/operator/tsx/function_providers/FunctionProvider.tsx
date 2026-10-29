import { Transform } from "roslib";
import { VelocityCommand } from "shared/commands";
import { RemoteRobot } from "shared/remoterobot";
import {
    DEFAULT_JOINT_VELOCITIES,
    JOINT_VELOCITY_HEARTBEAT_MS,
    PROFILE_SCALES,
    RobotPose,
    SpeedProfile,
    ValidJoints,
} from "shared/util";
import { PilotButtonPads } from "../static_components/PilotControlsToggle";
import { getLabelBySpeed } from "../utils/action-speed-scale";
import {
    ActionModeType,
    PilotButtonPadType,
} from "../utils/component_definitions";
import { clampTimedMoveMs } from "../utils/timed-move";
import { ButtonPadButton } from "./ButtonFunctionProvider";

const x = PilotButtonPads;

/**
 * Provides logic to connect the {@link RemoteRobot} and the components in the
 * interface
 */
export abstract class FunctionProvider {
    private static instances = new Set<FunctionProvider>();
    protected static remoteRobot?: RemoteRobot;
    public static speedProfile: SpeedProfile = "medium";
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
     * Registers this function provider instance so global stop actions can reach it.
     */
    constructor() {
        FunctionProvider.instances.add(this);
    }

    /**
     * Stops active motion and clears latched UI state across all registered function providers.
     *
     * Args:
     *     send_stop_command: Whether to transmit an explicit stop command to the robot.
     */
    public static stopAllActions(send_stop_command: boolean = true): void {
        FunctionProvider.instances.forEach((instance) => {
            instance.stopCurrentAction(send_stop_command);
        });
    }

    /**
     * Subclass hook invoked whenever {@link stopCurrentAction} completes so provider-owned
     * active or latched button state is cleared alongside motion cancellation.
     */
    protected onActionStopped(): void {}

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
     * Multiplier for the current speed setting.
     *
     * Returns:
     *     The current profile's PROFILE_SCALES entry.
     */
    static get velocityScale(): number {
        return PROFILE_SCALES[this.speedProfile];
    }

    /**
     * Select the speed profile carrying this multiplier.
     *
     * Args:
     *     scale: A multiplier from PROFILE_SCALES. Any other value selects medium.
     */
    static set velocityScale(scale: number) {
        this.speedProfile = getLabelBySpeed(scale) ?? "medium";
    }

    /**
     * Velocity of a joint at an explicit speed profile, in URDF units/s: the joint's
     * DEFAULT_JOINT_VELOCITIES entry, which is its medium speed, scaled by that profile.
     *
     * Voice commands carry their own speed and are independent of the interface's speedometer, so
     * they resolve velocities through this rather than through jointVelocity().
     *
     * Args:
     *     jointName: Joint to look up.
     *     profile: Speed profile to scale by.
     *
     * Returns:
     *     The velocity in URDF units/s, or undefined if the joint has no entry.
     */
    static jointVelocityAt(
        jointName: ValidJoints,
        profile: SpeedProfile,
    ): number | undefined {
        const velocity = DEFAULT_JOINT_VELOCITIES[jointName];
        return velocity === undefined ? undefined : velocity * PROFILE_SCALES[profile];
    }

    /**
     * Velocity of a joint at the speedometer's current setting, in URDF units/s. Velocities and
     * jog increments share that multiplier, so a speed profile changes a step action and a held
     * action by the same proportion.
     *
     * Args:
     *     jointName: Joint to look up.
     *
     * Returns:
     *     The velocity in URDF units/s, or undefined if the joint has no entry.
     */
    static jointVelocity(jointName: ValidJoints): number | undefined {
        return this.jointVelocityAt(jointName, this.speedProfile);
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

    /** True while a timed voice move or continuous velocity heartbeat is active. */
    public isMotionActive(): boolean {
        return (
            this.timedVoiceMoveActive ||
            this.velocityExecutionHeartbeat !== undefined ||
            this.activeVelocityAction !== undefined
        );
    }

    /**
     * Checks whether a continuous velocity command or heartbeat interval is currently active.
     *
     * Returns:
     *     True if a velocity heartbeat interval or velocity action is active.
     */
    public isVelocityHeartbeatActive(): boolean {
        return (
            this.velocityExecutionHeartbeat !== undefined ||
            this.activeVelocityAction !== undefined
        );
    }

    /**
     * Move the robot to an absolute pose (e.g. a voice macro).
     * Stops any ongoing velocity or timed move, then sends a setRobotPose command.
     *
     * Args:
     *     pose: Partial RobotPose mapping joint names to absolute target positions.
     *
     * Returns:
     *     False if no robot is connected, true otherwise.
     */
    public executeAbsolutePose(pose: RobotPose): boolean {
        if (!FunctionProvider.remoteRobot) return false;
        FunctionProvider.stopAllActions(true);
        FunctionProvider.remoteRobot.setRobotPose(pose);
        return true;
    }

    /**
     * Starts a 25 ms heartbeat streaming base velocity commands after stopping any prior motion.
     *
     * Args:
     *     linVelX: Forward/backward linear velocity in m/s.
     *     linVelY: Left/right strafe velocity in m/s.
     *     angVel: Yaw angular velocity in rad/s.
     */
    public setBaseVelocity(linVelX: number, linVelY: number, angVel: number) {
        FunctionProvider.stopAllActions(true);
        this.activeVelocityAction = FunctionProvider.remoteRobot?.driveBase(
            linVelX,
            linVelY,
            angVel
        );
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
     * Supersedes any active timed voice move so a new command can interrupt.
     *
     * Args:
     *     linVelX: Forward/backward linear velocity in m/s.
     *     linVelY: Left/right strafe velocity in m/s.
     *     durationMs: Duration in milliseconds to apply velocity.
     *     angVel: Yaw angular velocity in rad/s.
     *
     * Returns:
     *     False if no RemoteRobot is attached, true otherwise.
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

        const clampedMs = clampTimedMoveMs(durationMs);

        FunctionProvider.stopAllActions(true);
        this.setBaseVelocity(
            linVelX,
            linVelY,
            angVel
        );
        this.timedVoiceMoveActive = true;
        this.timedVoiceMoveTimer = setTimeout(() => {
            this.timedVoiceMoveTimer = undefined;
            this.timedVoiceMoveActive = false;
            this.stopCurrentAction(true);
        }, clampedMs);
        return true;
    }

    /**
     * Sends a single joint velocity command after stopping any active motion.
     *
     * Args:
     *     jointName: The joint to actuate.
     *     velocity: Signed velocity in joint units/s.
     */
    public incrementalJointMovement(jointName: ValidJoints, velocity: number) {
        FunctionProvider.stopAllActions(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot?.setJointVelocity(jointName, velocity);
    }

    /**
     * Starts a heartbeat streaming joint velocity commands after stopping any prior motion.
     *
     * Args:
     *     jointName: The joint to actuate.
     *     velocity: Signed velocity in joint units/s.
     */
    public continuousJointMovement(jointName: ValidJoints, velocity: number) {
        FunctionProvider.stopAllActions(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot?.setJointVelocity(
                jointName,
                velocity
            );
        this.velocityExecutionHeartbeat = window.setInterval(() => {
            this.activeVelocityAction =
                FunctionProvider.remoteRobot?.setJointVelocity(
                    jointName,
                    velocity
                );
        }, JOINT_VELOCITY_HEARTBEAT_MS);
    }

    /**
     * Starts a 50 ms heartbeat streaming tool-frame twist commands to /ee_cmd_vel.
     *
     * Args:
     *     linear_X: Tool-frame forward linear velocity in m/s.
     *     linear_Y: Tool-frame left linear velocity in m/s.
     *     linear_Z: Tool-frame up linear velocity in m/s.
     */
    public continuousTaskSpaceMovement(
        linear_X: number,
        linear_Y: number,
        linear_Z: number,
    ) {
        FunctionProvider.stopAllActions(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot?.setTaskSpaceVelocity(
                linear_X,
                linear_Y,
                linear_Z,
            );
        this.velocityExecutionHeartbeat = window.setInterval(() => {
            this.activeVelocityAction =
                FunctionProvider.remoteRobot?.setTaskSpaceVelocity(
                    linear_X,
                    linear_Y,
                    linear_Z,
                );
        }, 50);
    }

    /**
     * Move a joint continuously for durationMs then stop.
     * Uses the same timedVoiceMoveActive guard as timedBaseDrive so base and
     * joint timed moves are mutually exclusive.
     *
     * Args:
     *     jointName: The joint to actuate.
     *     velocity: Signed velocity in joint units/s (m/s for linear, rad/s for rotary).
     *     durationMs: How long to apply velocity (clamped internally).
     *
     * Returns:
     *     False if no robot is attached, true otherwise.
     */
    public timedJointMove(
        jointName: ValidJoints,
        velocity: number,
        durationMs: number,
    ): boolean {
        if (!FunctionProvider.remoteRobot) {
            return false;
        }

        const clampedMs = clampTimedMoveMs(durationMs);

        FunctionProvider.stopAllActions(true);
        this.continuousJointMovement(jointName, velocity);
        this.timedVoiceMoveActive = true;
        this.timedVoiceMoveTimer = setTimeout(() => {
            this.timedVoiceMoveTimer = undefined;
            this.timedVoiceMoveActive = false;
            this.stopCurrentAction(true);
        }, clampedMs);
        return true;
    }

    /**
     * Move a joint incrementally using the trajectory action server.
     * Stops any ongoing velocity or trajectory action first.
     *
     * Args:
     *     jointName: The joint to actuate.
     *     increment: The incremental distance/rotation (m or rad).
     *
     * Returns:
     *     False if no robot is attached, true otherwise.
     */
    public incrementalJointMove(
        jointName: ValidJoints,
        increment: number,
    ): boolean {
        if (!FunctionProvider.remoteRobot) {
            return false;
        }

        FunctionProvider.stopAllActions(true);
        this.activeVelocityAction =
            FunctionProvider.remoteRobot.incrementalMove(jointName, increment);
        return true;
    }

    /**
     * Cancels any active velocity stream or timed move on this provider and clears its latched UI state.
     *
     * Args:
     *     send_stop_command: Whether to transmit an explicit stop command to the robot.
     */
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
        this.onActionStopped();
    }
}
