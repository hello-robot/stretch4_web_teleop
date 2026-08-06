import React from "react";
import { createRoot } from "react-dom/client";
import "robot/css/index.css";
import { Transform } from "roslib";
import { loginFirebaseSignalerAsRobot } from "shared/signaling/get_signaler";
import {
    ActionState,
    ActionStateMessage,
    audioProps,
    BatteryVoltageMessage,
    delay,
    gripperProps,
    IsHomedMessage,
    IsRunStoppedMessage,
    MapPoseMessage,
    ModeMessage,
    navigationProps,
    OccupancyGridMessage,
    OdomMessage,
    RobotPose,
    ROSBatteryState,
    ROSOccupancyGrid,
    ROSOdometry,
    ValidJointStateDict,
    ValidJointStateMessage,
    WebRTCMessage,
} from "shared/util";
import { StretchToolMessage } from "../../../shared/util";
import { WebRTCConnection } from "../../../shared/webrtcconnections";
import { Robot } from "../../robot/tsx/robot";
import { AudioStream } from "./audiostreams";
import { AllVideoStreamComponent, VideoStream } from "./videostreams";

export const robot = new Robot({
    jointStateCallback: forwardJointStates,
    batteryStateCallback: forwardBatteryState,
    occupancyGridCallback: forwardOccupancyGrid,
    odomCallback: forwardOdom,
    moveBaseResultCallback: (goalState: ActionState) =>
        forwardActionState(goalState, "moveBaseState"),
    playbackPosesResultCallback: (goalState: ActionState) =>
        forwardActionState(goalState, "playbackPosesState"),
    amclPoseCallback: forwardAMCLPose,
    modeCallback: forwardMode,
    isHomedCallback: forwardIsHomed,
    isRunStoppedCallback: forwardIsRunStopped,
    stretchToolCallback: forwardStretchTool,
    leaseStatusCallback: forwardLeaseStatus,
});

export let connection: WebRTCConnection;
export let navigationStream = new VideoStream(navigationProps);
export let gripperStream = new VideoStream(gripperProps);
export let audioStream = new AudioStream(audioProps);
// let occupancyGrid: ROSOccupancyGrid | undefined;

connection = new WebRTCConnection({
    peerRole: "robot",
    polite: false,
    onRobotConnectionStart: handleSessionStart,
    onMessage: handleMessage,
    onConnectionEnd: disconnectFromRobot,
});
robot.setOnRosConnectCallback(async () => {
    robot.subscribeToVideo({
        topicName: "/navigation_camera/image_raw/rotated/compressed",
        callback: navigationStream.updateImage,
    });
    navigationStream.start();

    robot.subscribeToVideo({
        topicName: "/gripper_camera/image_raw/cropped/compressed",
        callback: gripperStream.updateImage,
    });
    gripperStream.start();

    audioStream.start();

    robot.getOccupancyGrid();

    console.log(
        "Waiting for configured signaler (i.e. logging in if using Firebase)"
    );
    await loginFirebaseSignalerAsRobot();
    await connection.configure_signaler("");
    console.log("Signaler ready! Joining room.");
    let joinedRobotRoom = await connection.joinRobotRoom();
    while (!joinedRobotRoom) {
        await delay(500);
        joinedRobotRoom = await connection.joinRobotRoom();
    }

    return Promise.resolve();
});
robot.connect();

function handleSessionStart() {
    connection.removeTracks();

    console.log("adding local media stream to peer connection");

    let stream: MediaStream = navigationStream.outputVideoStream!;
    stream
        .getTracks()
        .forEach((track) => connection.addTrack(track, stream, "overhead"));

    stream = gripperStream.outputVideoStream!;
    stream
        .getTracks()
        .forEach((track) => connection.addTrack(track, stream, "gripper"));

    stream = audioStream.outputAudioStream!;
    stream
        .getTracks()
        .forEach((track) => connection.addTrack(track, stream, "audio"));

    connection.openDataChannels();
}

function forwardActionState(state: ActionState, type: string) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: type,
        message: state,
    } as ActionStateMessage);
}

function forwardMode(mode: string) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "mode",
        value: mode,
    } as ModeMessage);
}

function forwardIsHomed(isHomed: boolean) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "isHomed",
        value: isHomed,
    } as IsHomedMessage);
}

function forwardIsRunStopped(isRunStopped: boolean) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "isRunStopped",
        enabled: isRunStopped,
    } as IsRunStoppedMessage);
}

function forwardLeaseStatus(holder: string, isDriverHolding: boolean) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "leaseStatus",
        holder: holder,
        isDriverHolding: isDriverHolding,
    } as LeaseStatusMessage);
}

function forwardStretchTool(value: string) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "stretchTool",
        value: value,
    } as StretchToolMessage);
}

function forwardJointStates(
    robotPose: RobotPose,
    jointValues: ValidJointStateDict,
    effortValues: ValidJointStateDict
) {
    if (!connection) throw "WebRTC connection undefined!";

    connection.sendData({
        type: "validJointState",
        robotPose: robotPose,
        jointsInLimits: jointValues,
        jointsInCollision: effortValues,
    } as ValidJointStateMessage);
}

function forwardBatteryState(batteryState: ROSBatteryState) {
    if (!connection) throw "WebRTC connection undefined";

    connection.sendData({
        type: "batteryVoltage",
        message: batteryState.voltage,
    } as BatteryVoltageMessage);
}

function forwardOdom(odom: ROSOdometry) {
    if (!connection) throw "WebRTC connection undefined";

    connection.sendData({
        type: "odom",
        message: odom,
    } as OdomMessage);
}

function forwardOccupancyGrid(occupancyGrid: ROSOccupancyGrid) {
    if (!connection) throw "WebRTC connection undefined";

    let splitOccupancyGrid: ROSOccupancyGrid = {
        header: occupancyGrid.header,
        info: occupancyGrid.info,
        data: [],
    };

    const data_size = 50000;
    for (let i = 0; i < occupancyGrid.data.length; i += data_size) {
        const data_chunk = occupancyGrid.data.slice(i, i + data_size);
        splitOccupancyGrid.data = data_chunk;
        connection.sendData({
            type: "occupancyGrid",
            message: splitOccupancyGrid,
        } as OccupancyGridMessage);
    }

    // occupancyGrid.data = occupancyGrid.data.slice(0, 70000)
    // console.log('forwarding', occupancyGrid)
    // connection.sendData({
    //     type: 'occupancyGrid',
    //     message: occupancyGrid
    // } as OccupancyGridMessage);
}

// Keep amclPose on the data channel during nav (joint state is chatty).
const AMCL_POSE_MIN_INTERVAL_MS = 500; // ~2 Hz max
const AMCL_POSE_HEARTBEAT_MS = 1000; // refresh even if nearly static
const AMCL_POSE_MIN_TRANSLATION_M = 0.02;
const AMCL_POSE_MIN_YAW_RAD = 0.03;
let lastAmclPoseSentAt = 0;
let lastAmclPoseSent: Transform | undefined;

function yawFromQuaternion(rotation: {
    x: number;
    y: number;
    z: number;
    w: number;
}): number {
    const sinyCosp = 2 * (rotation.w * rotation.z + rotation.x * rotation.y);
    const cosyCosp =
        1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z);
    return Math.atan2(sinyCosp, cosyCosp);
}

function amclPoseMovedEnough(transform: Transform): boolean {
    if (!lastAmclPoseSent) {
        return true;
    }
    const dx = transform.translation.x - lastAmclPoseSent.translation.x;
    const dy = transform.translation.y - lastAmclPoseSent.translation.y;
    const dist = Math.hypot(dx, dy);
    let dyaw = Math.abs(
        yawFromQuaternion(transform.rotation) -
        yawFromQuaternion(lastAmclPoseSent.rotation),
    );
    if (dyaw > Math.PI) {
        dyaw = 2 * Math.PI - dyaw;
    }
    return (
        dist >= AMCL_POSE_MIN_TRANSLATION_M || dyaw >= AMCL_POSE_MIN_YAW_RAD
    );
}

function forwardAMCLPose(transform: Transform) {
    if (!connection) throw "WebRTC connection undefined";

    const now = Date.now();
    const elapsed = now - lastAmclPoseSentAt;
    if (elapsed < AMCL_POSE_MIN_INTERVAL_MS) {
        return;
    }
    if (
        lastAmclPoseSent &&
        !amclPoseMovedEnough(transform) &&
        elapsed < AMCL_POSE_HEARTBEAT_MS
    ) {
        return;
    }

    lastAmclPoseSentAt = now;
    lastAmclPoseSent = transform;
    connection.sendData({
        type: "amclPose",
        message: transform,
    } as MapPoseMessage);
}

function handleMessage(message: WebRTCMessage) {
    if (!("type" in message)) {
        console.error("Malformed message:", message);
        return;
    }

    switch (message.type) {
        case "driveBase":
            robot.executeBaseVelocity(message.modifier);
            break;
        case "setJointVelocity":
            robot.setJointVelocity(message.jointName, message.velocity);
            break;
        case "incrementalMove":
            robot.executeIncrementalMove(message.jointName, message.increment);
            break;
        case "stopTrajectory":
            robot.stopTrajectoryClient();
            break;
        case "stopMoveBase":
            robot.stopMoveBaseClient();
            break;
        case "setRobotMode":
            message.modifier == "navigation"
                ? robot.switchToNavigationMode()
                : robot.switchToPositionMode();
            break;
        case "setCameraPerspective":
            if (message.perspective == "left") robot.useLeftCamera();
            else if (message.perspective == "right") robot.useRightCamera();
            else if (message.perspective == "center") robot.useCenterCamera();
            break;
        case "setRobotPose":
            robot.executePoseGoal(message.pose);
            break;
        case "playbackPoses":
            robot.executePoseGoals(message.poses, 0);
            break;
        case "moveBase":
            robot.executeMoveBaseGoal(message.pose);
            break;
        case "setExpandedGripper":
            robot.setExpandedGripper(message.toggle);
            break;
        case "setRunStop":
            robot.setRunStop(message.toggle);
            break;
        case "getOccupancyGrid":
            robot.getOccupancyGrid();
            break;
        case "getStretchTool":
            robot.getStretchTool();
            break;
        case "homeTheRobot":
            robot.homeTheRobot();
            break;
        case "seedLocalization":
            robot.seedLocalization((response) => {
                forwardActionState(
                    {
                        state: response.message,
                        alert_type: response.success ? "success" : "error",
                    },
                    "seedLocalizationState"
                );
            });
            break;
    }
}

function disconnectFromRobot() {
    robot.closeROSConnection();
    connection.hangup();
}

window.onbeforeunload = () => {
    robot.closeROSConnection();
    connection.hangup();
};

// New method of rendering in react 18
const container = document.getElementById("root");
const root = createRoot(container!); // createRoot(container!) if you use TypeScript
root.render(
    <AllVideoStreamComponent
        streams={[navigationStream, gripperStream]}
    />
);
