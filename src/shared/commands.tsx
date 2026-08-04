
import { ROSPose, RobotPose } from "./util";
import { ValidJoints } from "./util";

export type cmd =
    | DriveCommand
    | SetJointVelocityCommand
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
    | HomeTheRobotCommand;

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
