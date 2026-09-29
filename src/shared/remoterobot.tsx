import React from "react";
import { Transform, Vector3, Quaternion } from "roslib";
import {
    cmd,
    DriveCommand,
    CameraPerspectiveCommand,
    IncrementalMove,
    setRobotModeCommand,
    VelocityCommand,
    RobotPoseCommand,
    ToggleCommand,
    GetOccupancyGrid,
    MoveBaseCommand,
    PlaybackPosesCommand,
    HomeTheRobotCommand,
    GetStretchTool,
    SetJointVelocityCommand,
    SeedLocalizationCommand,
} from "shared/commands";
import {
    ValidJointStateDict,
    RobotPose,
    ValidJoints,
    ROSPose,
    waitUntil,
    ROSOdometry,
} from "shared/util";
export type robotMessageChannel = (message: cmd) => void;

export class RemoteRobot extends React.Component<{}, any> {
    robotChannel: robotMessageChannel;
    sensors: RobotSensors;
    isRunStopped: boolean;
    batteryVoltage: number;
    mapPose: Transform;
    moveBaseGoalReached: boolean;
    moveBaseState?: string;
    private mapPoseListeners: Set<(pose: Transform) => void> = new Set();

    constructor(props: { robotChannel: robotMessageChannel }) {
        super(props);
        this.robotChannel = props.robotChannel;
        this.sensors = new RobotSensors({});
        this.isRunStopped = false;
        this.batteryVoltage = 13.0;
        this.mapPose = {
            translation: {
                x: 0,
                y: 0,
                z: 0,
            } as Vector3,
            rotation: {
                x: 0,
                y: 0,
                z: 0,
                w: 0,
            } as Quaternion,
        } as Transform;
        this.moveBaseGoalReached = false;
    }

    setGoalReached(reached: boolean) {
        this.moveBaseGoalReached = reached;
    }

    isGoalReached() {
        return this.moveBaseGoalReached;
    }

    driveBase(
        linVelX: number,
        linVelY: number,
        angVel: number
    ): VelocityCommand {
        if (!this.sensors.getLeaseDriverHolding()) {
            return {
                stop: () => {},
                affirm: () => {},
            };
        }

        let cmd: DriveCommand = {
            type: "driveBase",
            modifier: { linVelX: linVelX, linVelY: linVelY, angVel: angVel },
        };
        this.robotChannel(cmd);

        return {
            stop: () => {
                let stopEvent: DriveCommand = {
                    type: "driveBase",
                    modifier: { linVelX: 0, linVelY: 0, angVel: 0 },
                };
                this.robotChannel(stopEvent);
            },
            affirm: () => {
                let affirmEvent: DriveCommand = {
                    type: "driveBase",
                    modifier: {
                        linVelX: linVelX,
                        linVelY: linVelY,
                        angVel: angVel,
                    },
                };
                this.robotChannel(affirmEvent);
            },
        };
    }

    setJointVelocity(
        jointName: ValidJoints,
        velocity: number
    ): VelocityCommand {
        if (!this.sensors.getLeaseDriverHolding()) {
            return {
                stop: () => {},
            };
        }

        let cmd: SetJointVelocityCommand = {
            type: "setJointVelocity",
            jointName: jointName,
            velocity: velocity,
        };
        this.robotChannel(cmd);

        return {
            stop: () => {
                let stopEvent: SetJointVelocityCommand = {
                    type: "setJointVelocity",
                    jointName: jointName,
                    velocity: 0,
                };
                this.robotChannel(stopEvent);
            },
        };
    }

    incrementalMove(
        jointName: ValidJoints,
        increment: number
    ): VelocityCommand {
        let cmd: IncrementalMove = {
            type: "incrementalMove",
            jointName: jointName,
            increment: increment,
        };
        this.robotChannel(cmd);

        return {
            stop: () => {
                this.robotChannel({ type: "stopTrajectory" });
            },
        };
    }

    setRobotMode(mode: "position" | "navigation") {
        let cmd: setRobotModeCommand = {
            type: "setRobotMode",
            modifier: mode,
        };
        this.robotChannel(cmd);
    }

    setCameraPerspective(perspective: "left" | "center" | "right") {
        let cmd: CameraPerspectiveCommand = {
            type: "setCameraPerspective",
            perspective: perspective,
        };
        this.robotChannel(cmd);
    }

    setRobotPose(pose: RobotPose) {
        let cmd: RobotPoseCommand = {
            type: "setRobotPose",
            pose: pose,
        };
        this.robotChannel(cmd);
    }

    playbackPoses(poses: RobotPose[]) {
        let cmd: PlaybackPosesCommand = {
            type: "playbackPoses",
            poses: poses,
        };
        this.robotChannel(cmd);
    }

    moveBase(pose: ROSPose) {
        this.setGoalReached(false);
        let cmd: MoveBaseCommand = {
            type: "moveBase",
            pose: pose,
        };
        this.robotChannel(cmd);
    }


    setToggle(
        type: "setRunStop",
        toggle: boolean
    ) {
        let cmd: ToggleCommand = {
            type: type,
            toggle: toggle,
        };
        this.robotChannel(cmd);
    }


    getOccupancyGrid(type: "getOccupancyGrid") {
        let cmd: GetOccupancyGrid = {
            type: type,
        };
        this.robotChannel(cmd);
    }

    getStretchTool(type: "getStretchTool") {
        let cmd: GetStretchTool = {
            type: type,
        };
        this.robotChannel(cmd);
    }

    setMapPose(pose: Transform) {
        this.mapPose = pose;
        this.mapPoseListeners.forEach((listener) => {
            try {
                listener(pose);
            } catch (err) {
                console.warn("mapPose listener failed:", err);
            }
        });
    }

    getMapPose() {
        return this.mapPose;
    }

    /**
     * Subscribe to map pose (amcl) updates. Returns an unsubscribe function.
     */
    addMapPoseListener(listener: (pose: Transform) => void): () => void {
        this.mapPoseListeners.add(listener);
        return () => {
            this.mapPoseListeners.delete(listener);
        };
    }

    stopTrajectory() {
        this.robotChannel({ type: "stopTrajectory" });
    }

    stopMoveBase() {
        this.robotChannel({ type: "stopMoveBase" });
    }

    /**
     * Ask the robot to home itself.
     */
    homeTheRobot() {
        let cmd: HomeTheRobotCommand = {
            type: "homeTheRobot",
        };
        this.robotChannel(cmd);
    }

    /**
     * Ask the robot to seed its localization.
     */
    seedLocalization() {
        let cmd: SeedLocalizationCommand = {
            type: "seedLocalization",
        };
        this.robotChannel(cmd);
    }
}

class RobotSensors extends React.Component {
    private batteryVoltage: number = 0.0;
    private robotPose: RobotPose = {};
    private inJointLimits: ValidJointStateDict = {};
    private inCollision: ValidJointStateDict = {};
    private mode: string | undefined = undefined;
    private isHomed: boolean | undefined = undefined;
    private runStopEnabled: boolean = false;
    private odom: ROSOdometry | undefined = undefined;
    private leaseHolder: string = "none";
    private leaseDriverHolding: boolean = true;
    private functionProviderCallback?: (
        inJointLimits: ValidJointStateDict,
        inCollision: ValidJointStateDict
    ) => void;
    private batteryFunctionProviderCallback?: (voltage: number) => void;
    private modeFunctionProviderCallback?: (mode: string) => void;
    private isHomedFunctionProviderCallback?: (isHomed: boolean) => void;
    private runStopFunctionProviderCallback?: (enabled: boolean) => void;
    private leaseStatusFunctionProviderCallback?: (holder: string, isDriverHolding: boolean) => void;
    private jointStateFunctionProviderCallback?: (robotPose: RobotPose) => void;

    constructor(props: {}) {
        super(props);
        this.functionProviderCallback = () => { };
        this.batteryFunctionProviderCallback = () => { };
        this.modeFunctionProviderCallback = () => { };
        this.isHomedFunctionProviderCallback = () => { };
        this.runStopFunctionProviderCallback = () => { };
        this.leaseStatusFunctionProviderCallback = () => { };
        this.setFunctionProviderCallback =
            this.setFunctionProviderCallback.bind(this);
        this.setBatteryFunctionProviderCallback =
            this.setBatteryFunctionProviderCallback.bind(this);
        this.setModeFunctionProviderCallback =
            this.setModeFunctionProviderCallback.bind(this);
        this.setIsHomedFunctionProviderCallback =
            this.setIsHomedFunctionProviderCallback.bind(this);
        this.setRunStopFunctionProviderCallback =
            this.setRunStopFunctionProviderCallback.bind(this);
        this.setLeaseStatusFunctionProviderCallback =
            this.setLeaseStatusFunctionProviderCallback.bind(this);
        this.setJointStateFunctionProviderCallback =
            this.setJointStateFunctionProviderCallback.bind(this);
    }

    /**
     * Handler for joint state messages with information about if individual
     * joints are in collision or at their limit.
     *
     * @param jointValues mapping of joint name to a pair of booleans for
     *                    [joint is within lower limit, joint is within upper limit]
     * @param effortValues mapping for joint name to pair of booleans for
     *                     [joint in collision at lower end, joint is in
     *                     collision at upper end]
     */
    checkValidJointState(
        robotPose: RobotPose,
        jointValues: ValidJointStateDict,
        effortValues: ValidJointStateDict
    ) {
        if (robotPose !== this.robotPose) {
            this.robotPose = robotPose;
        }

        // Remove existing values from list
        let change = false;
        Object.keys(jointValues).forEach((k) => {
            const key = k as ValidJoints;

            const same =
                key in this.inJointLimits
                    ? jointValues[key]![0] == this.inJointLimits[key]![0] &&
                    jointValues[key]![1] == this.inJointLimits[key]![1]
                    : false;
            // If same value, remove from dict so not passed to callback
            if (same) delete jointValues[key];
            else {
                change = true;
                this.inJointLimits[key] = jointValues[key];
            }
        });
        Object.keys(effortValues).forEach((k) => {
            const key = k as ValidJoints;
            const same =
                key in this.inCollision
                    ? effortValues[key]![0] == this.inCollision[key]![0] &&
                    effortValues[key]![1] == this.inCollision[key]![1]
                    : false;
            // If same value, remove from dict so not passed to callback
            if (same) delete effortValues[key];
            else {
                change = true;
                this.inCollision[key] = effortValues[key];
            }
        });

        // Call the callback when joint limits or in collition joints have changed.
        if (change && this.functionProviderCallback) {
            this.functionProviderCallback(
                this.inJointLimits,
                this.inCollision
            );
        }

        // Call the callback when a new joint state is received.
        if (this.jointStateFunctionProviderCallback) {
            this.jointStateFunctionProviderCallback(this.robotPose);
        }
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever a joint state "at limit" or "in collision" changes.
     *
     * @param callback callback to function provider
     */
    setFunctionProviderCallback(
        callback: (
            inJointLimits: ValidJointStateDict,
            inCollision: ValidJointStateDict
        ) => void
    ) {
        this.functionProviderCallback = callback;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever a new joint state is received.
     *
     * @param callback callback to function provider
     */
    setJointStateFunctionProviderCallback(
        callback: (robotPose: RobotPose) => void
    ) {
        this.jointStateFunctionProviderCallback = callback;
    }

    setBatteryVoltage(voltage: number) {
        let change = Math.abs(this.batteryVoltage - voltage) > 0.01;
        if (change && this.batteryFunctionProviderCallback) {
            this.batteryVoltage = voltage;
            this.batteryFunctionProviderCallback(this.batteryVoltage);
        }
    }

    setMode(mode: string) {
        this.mode = mode;
        if (this.modeFunctionProviderCallback)
            this.modeFunctionProviderCallback(this.mode);
    }

    setIsHomed(isHomed: boolean) {
        this.isHomed = isHomed;
        if (this.isHomedFunctionProviderCallback)
            this.isHomedFunctionProviderCallback(this.isHomed);
    }

    setRunStopState(enabled: boolean) {
        this.runStopEnabled = enabled;
        if (this.runStopFunctionProviderCallback)
            this.runStopFunctionProviderCallback(this.runStopEnabled);
    }

    setLeaseStatus(holder: string, isDriverHolding: boolean) {
        this.leaseHolder = holder;
        this.leaseDriverHolding = isDriverHolding;
        if (this.leaseStatusFunctionProviderCallback)
            this.leaseStatusFunctionProviderCallback(this.leaseHolder, this.leaseDriverHolding);
    }

    getLeaseHolder(): string {
        return this.leaseHolder;
    }

    getLeaseDriverHolding(): boolean {
        return this.leaseDriverHolding;
    }

    setOdom(odom: ROSOdometry) {
        this.odom = odom;
    }

    /** Returns the latest odometry snapshot, or undefined if none has been received yet. */
    getOdom(): ROSOdometry | undefined {
        return this.odom;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever the battery voltage changes.
     *
     * @param callback callback to function provider
     */
    setBatteryFunctionProviderCallback(callback: (voltage: number) => void) {
        this.batteryFunctionProviderCallback = callback;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever the driver's mode changes.
     *
     * @param callback callback to function provider
     */
    setModeFunctionProviderCallback(callback: (mode: string) => void) {
        this.modeFunctionProviderCallback = callback;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever the "is_homed" state changes.
     *
     * @param callback callback to function provider
     */
    setIsHomedFunctionProviderCallback(callback: (isHomed: boolean) => void) {
        this.isHomedFunctionProviderCallback = callback;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever the battery voltage changes.
     *
     * @param callback callback to function provider
     */
    setRunStopFunctionProviderCallback(callback: (enabled: boolean) => void) {
        this.runStopFunctionProviderCallback = callback;
    }

    /**
     * Records a callback from the function provider. The callback is called
     * whenever the lease status changes.
     *
     * @param callback callback to function provider
     */
    setLeaseStatusFunctionProviderCallback(callback: (holder: string, isDriverHolding: boolean) => void) {
        this.leaseStatusFunctionProviderCallback = callback;
    }

    /**
     * @returns current robot pose
     */
    getRobotPose(
        arm: boolean,
        lift: boolean,
        wrist_roll: boolean,
        wrist_pitch: boolean,
        wrist_yaw: boolean,
        gripper: boolean
    ): RobotPose {
        let filteredPose: RobotPose = {};
        if (arm) {
            filteredPose["arm_joint"] = this.robotPose["arm_joint"];
        }
        if (lift) {
            filteredPose["lift_joint"] = this.robotPose["lift_joint"];
        }
        if (wrist_roll) {
            filteredPose["wrist_roll_joint"] =
                this.robotPose["wrist_roll_joint"];
        }
        if (wrist_pitch) {
            filteredPose["wrist_pitch_joint"] =
                this.robotPose["wrist_pitch_joint"];
        }
        if (wrist_yaw) {
            filteredPose["wrist_yaw_joint"] = this.robotPose["wrist_yaw_joint"];
        }
        if (gripper) {
            filteredPose["stretch_gripper_joint"] = this.robotPose["stretch_gripper_joint"];
        }
        return filteredPose;
    }
}
