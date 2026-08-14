import { Transform, Message } from "roslib";
import { cmd } from "./commands";

export type ValidJoints =
    | "head_tilt_joint"
    | "head_pan_joint"
    | "stretch_gripper_joint"
    | "arm_joint"
    | "wrist_extension"
    | "lift_joint"
    | "wrist_roll_joint"
    | "wrist_pitch_joint"
    | "wrist_yaw_joint"
    | "translate_mobile_base"
    | "rotate_mobile_base"
    | "gripper_aperture"
    | "arm_l0_joint"
    | "arm_l1_joint"
    | "arm_l2_joint"
    | "arm_l3_joint"
    | "arm_l4_joint";



export type RemoteStream = {
    stream: MediaStream;
    track: MediaStreamTrack;
};

export type ValidJointStateDict = { [key in ValidJoints]?: [boolean, boolean] };

export interface ROSJointState extends Message {
    name: [ValidJoints?];
    position: [number];
    effort: [number];
    velocity: [number];
}

export interface DiagnosticArray extends Message {
    status: DiagnosticStatus[];
}

export interface DiagnosticStatus extends Message {
    name: string;
    level: number;
    message: string;
    hardware_id: string;
    values: KeyValue[];
}

export interface KeyValue {
    key: string;
    value: string;
}
export enum StretchTool {
    DW4 = "eoa_wrist_dw4_tool_sg4",
    TABLET = "eoa_wrist_dw3_tool_tablet",
    UNKNOWN = "unknown",
}



export function getStretchTool(stretchTool: string) {
    if (stretchTool === "eoa_wrist_dw3_tool_tablet") {
        return StretchTool.TABLET;
    } else if (stretchTool === "eoa_wrist_dw4_tool_sg4") {
        return StretchTool.DW4;
    } else {
        return StretchTool.UNKNOWN;
    }
}



export interface ROSBatteryState extends Message {
    voltage: number;
}

export interface ROSCompressedImage extends Message {
    header: string;
    format: "jpeg" | "png";
    data: string;
}

export interface CameraInfo {
    [key: string]: string;
}

export interface SignallingMessage {
    candidate?: RTCIceCandidate;
    sessionDescription?: RTCSessionDescription;
    cameraInfo?: CameraInfo;
}



export type WebRTCMessage =
    | ValidJointStateMessage
    | OccupancyGridMessage
    | MapPoseMessage
    | StopTrajectoryMessage
    | StopMoveBaseMessage

    | BatteryVoltageMessage
    | ModeMessage
    | IsHomedMessage
    | IsRunStoppedMessage
    | StretchToolMessage
    | ActionStateMessage
    | SeedLocalizationStateMessage
    | cmd;

interface StopTrajectoryMessage {
    type: "stopTrajectory";
}

interface StopMoveBaseMessage {
    type: "stopMoveBase";
}

export type RobotPose = { [key in ValidJoints]?: number };

export interface ValidJointStateMessage {
    type: "validJointState";
    robotPose: RobotPose;
    jointsInLimits: { [key in ValidJoints]?: [boolean, boolean] };
    jointsInCollision: { [key in ValidJoints]?: [boolean, boolean] };
}

export interface ModeMessage {
    type: "mode";
    value: string;
}

export interface IsHomedMessage {
    type: "isHomed";
    value: boolean;
}

export interface IsRunStoppedMessage {
    type: "isRunStopped";
    enabled: boolean;
}

export interface StretchToolMessage {
    type: "stretchTool";
    value: string;
}



export interface ActionState {
    state: string;
    alert_type: string;
}

export interface ActionStateMessage {
    type: string;
    message: ActionState;
}

export interface SeedLocalizationStateMessage {
    type: "seedLocalizationState";
    message: ActionState;
}

export interface ActionStatusList {
    status_list: { status: number }[];
}

export interface OccupancyGridMessage {
    type: "occupancyGrid";
    message: ROSOccupancyGrid;
}

export interface MapPoseMessage {
    type: "amclPose";
    message: Transform;
}

export interface BatteryVoltageMessage {
    type: "batteryVoltage";
    message: number;
}

export interface ROSPoint extends Message {
    x: number;
    y: number;
    z: number;
}

export interface ROSQuaternion extends Message {
    x: number;
    y: number;
    z: number;
    w: number;
}

export interface ROSPose extends Message {
    position: ROSPoint;
    orientation: ROSQuaternion;
}

export interface ROSMapMetaData extends Message {
    map_load_time: number;
    resolution: number;
    width: number;
    height: number;
    origin: ROSPose;
}

export interface ROSOccupancyGrid {
    header: string;
    info: ROSMapMetaData;
    data: number[];
}

export const JOINT_LIMITS: { [key in ValidJoints]?: [number, number] } = {
    arm_joint: [0.001, 0.518],
    wrist_roll_joint: [-2.95, 2.94],
    wrist_pitch_joint: [-1.57, 0.57],
    wrist_yaw_joint: [-1.37, 4.41],
    lift_joint: [0.001, 1.1],
    translate_mobile_base: [-30.0, 30.0],
    rotate_mobile_base: [-3.14, 3.14],
    stretch_gripper_joint: [-0.37, 0.17],
    head_tilt_joint: [-1.6, 0.3],
    head_pan_joint: [-3.95, 1.7],
};

export const JOINT_VELOCITIES: { [key in ValidJoints]?: number } = {
    head_tilt_joint: 0.3,
    head_pan_joint: 0.3,
    arm_joint: 0.04,
    lift_joint: 0.04,
    wrist_roll_joint: 0.5,
    wrist_pitch_joint: 0.5,
    wrist_yaw_joint: 1.0,
    translate_mobile_base: 0.2,
    rotate_mobile_base: 0.3,
};

export const JOINT_INCREMENTS: { [key in ValidJoints]?: number } = {
    head_tilt_joint: 0.1,
    head_pan_joint: 0.1,
    stretch_gripper_joint: 0.1,
    arm_joint: 0.1,
    lift_joint: 0.1,
    wrist_roll_joint: 0.1,
    wrist_pitch_joint: 0.1,
    wrist_yaw_joint: 0.1,
    translate_mobile_base: 0.2,
    rotate_mobile_base: 0.5,
};

const MOVE_TO_POSE_PLAYBACK_GAIN = 1.25;  // Gain factor for move-to-pose playback

export function getPlaybackJointVelocity(jointName: ValidJoints): number {
    return (JOINT_VELOCITIES[jointName] || 0.1) * MOVE_TO_POSE_PLAYBACK_GAIN;
}

export function getPlaybackJointVelocities(jointNames: ValidJoints[]): number[] {
    return jointNames.map(getPlaybackJointVelocity);
}

export const navigationProps = {
    width: 768, // 800,
    height: 768, // 1280,
    scale: 1,
    fps: 6.0,
    streamName: "navigation",
};

export const gripperProps = {
    width: 768, // 1024
    height: 768,
    scale: 1,
    fps: 6.0,
    streamName: "gripper",
};

// audioProps are empty for now, but are included in case we want to customize
// the audio stream in the future.
export const audioProps = {};

export interface VideoProps {
    topicName: string;
    callback: (message: ROSCompressedImage) => void;
}

export function rosJointStatetoRobotPose(jointState: ROSJointState): RobotPose {
    let robotPose: RobotPose = {};
    const names = jointState.name;
    const positions = jointState.position;
    names.map((name, index) => {
        if (name) {
            robotPose[name] = positions[index];
        }
    });
    return robotPose;
}
////////////////////////////////////////////////////////////
// safelyParseJSON code copied from
// https://stackoverflow.com/questions/29797946/handling-bad-json-parse-in-node-safely
// on August 18, 2017
export function safelyParseJSON<T = any>(json: string): T {
    // This function cannot be optimized, it's best to
    // keep it small!
    let parsed;

    try {
        parsed = JSON.parse(json);
    } catch (e) {
        console.warn(e);
    }

    return parsed; // Could be undefined!
}

export type uuid = string;
// From: https://stackoverflow.com/a/2117523/6454085
export function generateUUID(): uuid {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        function (c) {
            var r = (Math.random() * 16) | 0,
                v = c == "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        }
    );
}

export async function waitUntil(
    condition,
    timeout = 5000,
    checkInterval = 100
) {
    let interval;
    let waitPromise = new Promise((resolve) => {
        interval = setInterval(() => {
            if (!condition()) {
                return;
            }
            clearInterval(interval);
            resolve(true);
        }, checkInterval);
    });
    let timeoutPromise = new Promise((resolve) =>
        setTimeout(() => {
            clearInterval(interval);
            resolve(false);
        }, timeout)
    );
    return await Promise.any([waitPromise, timeoutPromise]);
}

export async function waitUntilAsync(
    condition,
    timeout = 5000,
    checkInterval = 100
) {
    let interval;
    let waitPromise = new Promise((resolve) => {
        interval = setInterval(async () => {
            let value = await condition();
            if (!value) {
                return;
            }
            clearInterval(interval);
            resolve(true);
        }, checkInterval);
    });
    let timeoutPromise = new Promise((resolve) =>
        setTimeout(() => {
            clearInterval(interval);
            resolve(false);
        }, timeout)
    );
    return await Promise.any([waitPromise, timeoutPromise]);
}

export const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Creates a class name string based on a base class name and additional flags
 * to include.
 *
 * @param baseName base name of the class
 * @param flags additional flags to append to the class name
 * @returns returns a string for the class name
 *
 * @example ```js
 * className("foreground-button", {"active": false, "customizing": true})
 * // returns "foreground-button customizing"
 * ```
 */
export function className(baseName: string, flags: {}): string {
    let className = baseName;
    for (const [k, b] of Object.entries(flags)) {
        if (b) {
            className += " " + k;
        }
    }
    return className;
}
