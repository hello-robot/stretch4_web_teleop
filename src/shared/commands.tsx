
import { ROSPose, RobotPose } from "./util";
import { ValidJoints } from "./util";

export type cmd =
    | DriveCommand
    | SetJointVelocityCommand
    | SetTaskSpaceVelocityCommand
    | IncrementalMove
    | setRobotModeCommand
    | CameraPerspectiveCommand
    | RobotPoseCommand
    | ToggleCommand
    | GetOccupancyGrid
    | MoveBaseCommand
    | StopTrajectoryCommand
    | StopMoveBaseCommand
    | PlaybackPosesCommand
    | GetBatteryVoltageCommand
    | GetStretchTool
    | HomeTheRobotCommand
    | SeedLocalizationCommand
    | GetVoiceCapabilityCommand
    | RequestVoiceTokenCommand;

export interface SeedLocalizationCommand {
    type: "seedLocalization";
}

/** Ask the robot whether its server can mint OpenAI Realtime credentials. */
export interface GetVoiceCapabilityCommand {
    type: "getVoiceCapability";
}

/**
 * Ask the robot to mint an OpenAI Realtime ephemeral credential and relay it
 * back over the data channel (used when the operator page cannot reach the
 * robot's local server, e.g. Firebase Hosting).
 */
export interface RequestVoiceTokenCommand {
    type: "requestVoiceToken";
}

export interface VelocityCommand {
    stop: () => void;
    affirm?: () => void;
}

export interface DriveCommand {
    type: "driveBase";
    modifier: {
        linVelX: number;
        linVelY: number;
        angVel: number;
    };
}

export interface SetJointVelocityCommand {
    type: "setJointVelocity";
    jointName: ValidJoints;
    velocity: number;
}

/** Tool-frame linear twist for stretch_kinematics task_space_controller (/ee_cmd_vel). */
export interface SetTaskSpaceVelocityCommand {
    type: "setTaskSpaceVelocity";
    linear_X: number;
    linear_Y: number;
    linear_Z: number;
}

export interface IncrementalMove {
    type: "incrementalMove";
    jointName: ValidJoints;
    increment: number;
}

export interface RobotPoseCommand {
    type: "setRobotPose";
    pose: RobotPose;
}

export interface PlaybackPosesCommand {
    type: "playbackPoses";
    poses: RobotPose[];
}

export interface setRobotModeCommand {
    type: "setRobotMode";
    modifier: "position" | "navigation";
}

export interface CameraPerspectiveCommand {
    type: "setCameraPerspective";
    perspective: "left" | "center" | "right";
}

export interface ToggleCommand {
    type: "setRunStop";
    toggle: boolean;
}

export interface GetOccupancyGrid {
    type: "getOccupancyGrid";
}

export interface GetStretchTool {
    type: "getStretchTool";
}

export interface MoveBaseCommand {
    type: "moveBase";
    pose: ROSPose;
}

export interface StopTrajectoryCommand {
    type: "stopTrajectory";
}

export interface StopMoveBaseCommand {
    type: "stopMoveBase";
}

export interface GetBatteryVoltageCommand {
    type: "getBatteryVoltage";
}

export interface HomeTheRobotCommand {
    type: "homeTheRobot";
}
