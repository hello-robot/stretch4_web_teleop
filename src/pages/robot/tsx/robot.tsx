import React from "react";
import {
    Ros,
    Action,
    Goal,
    Topic,
    Service,
    ROS2TFClient,
    Transform,
    Param,
    Message,
} from "roslib";
import {
    ROSJointState,
    ROSCompressedImage,
    ValidJoints,
    VideoProps,
    ROSOccupancyGrid,
    ROSPose,
    ActionState,
    ActionStatusList,
    ROSBatteryState,
    StretchTool,
    getStretchTool,
} from "shared/util";
import {
    rosJointStatetoRobotPose,
    ValidJointStateDict,
    RobotPose,
    IsRunStoppedMessage,
} from "../../../shared/util";

export var robotMode: "navigation" | "position" | "velocity" | "unknown" = "position";
export var rosConnected = false;

// Constants for movement states
export enum MovementState {
    Executing = "movement executing!",
    Success = "movement successful!",
    Cancel = "movement canceled!",
    Fail = "movement failed!",
}

// Enum for movement states
export const movementStatesTerminal: MovementState[] = [
    MovementState.Success,
    MovementState.Cancel,
    MovementState.Fail,
];
export const movementStatesTransitory: MovementState[] = [MovementState.Executing];

export const movementStatesAll = Object.values(MovementState);

// Names of ROS actions
const moveBaseActionName = "/navigate_to_pose";
const followJointTrajectoryActionName = "/follow_joint_trajectory";

export class Robot extends React.Component {
    private ros: Ros;
    private readonly rosURL = "wss://localhost:9090";
    private rosReconnectTimerID?: ReturnType<typeof setTimeout>;
    private onRosConnectCallback?: () => Promise<void>;
    private jointLimits: { [key in ValidJoints]?: [number, number] } = {};
    private jointState?: ROSJointState;
    private poseGoal?: Goal;
    private poseGoalID?: string;
    private isRunStopped?: boolean;
    private moveBaseGoal?: Goal;
    private trajectoryClient?: Action;
    private moveBaseClient?: Action;
    private cmdVelTopic?: Topic;
    private jointVelTopic?: Topic;
    private useCenterCameraService?: Service;
    private useLeftCameraService?: Service;
    private useRightCameraService?: Service;
    private setExpandedGripperService?: Service;
    private setRunStopService?: Service;
    private robotFrameTfClient?: ROS2TFClient;
    private mapFrameTfClient?: ROS2TFClient;
    private linkGripperFingerLeftTF?: Transform;
    private linkWristYawTF?: Transform;
    private linkHeadTiltTF?: Transform;
    private jointStateCallback: (
        robotPose: RobotPose,
        jointValues: ValidJointStateDict,
        effortValues: ValidJointStateDict
    ) => void;
    private batteryStateCallback: (batteryState: ROSBatteryState) => void;
    private occupancyGridCallback: (occupancyGrid: ROSOccupancyGrid) => void;
    private moveBaseResultCallback: (goalState: ActionState) => void;
    private playbackPosesResultCallback: (goalState: ActionState) => void;
    private amclPoseCallback: (pose: Transform) => void;
    private modeCallback: (mode: string) => void;
    private isHomedCallback: (isHomed: boolean) => void;
    private isRunStoppedCallback: (isRunStopped: boolean) => void;
    private stretchToolCallback: (value: string) => void;
    private subscriptions: Topic[] = [];
    private stretchToolParam: Param;
    private modeParam: Param;
    private homeTheRobotService?: Service;
    private stretchTool: StretchTool;

    constructor(props: {
        jointStateCallback: (
            robotPose: RobotPose,
            jointValues: ValidJointStateDict,
            effortValues: ValidJointStateDict
        ) => void;
        batteryStateCallback: (batteryState: ROSBatteryState) => void;
        occupancyGridCallback: (occupancyGrid: ROSOccupancyGrid) => void;
        moveBaseResultCallback: (goalState: ActionState) => void;
        playbackPosesResultCallback: (goalState: ActionState) => void;
        amclPoseCallback: (pose: Transform) => void;
        modeCallback: (mode: string) => void;
        isHomedCallback: (isHomed: boolean) => void;
        isRunStoppedCallback: (isRunStopped: boolean) => void;
        stretchToolCallback: (value: string) => void;
    }) {
        super(props);
        this.jointStateCallback = props.jointStateCallback;
        this.batteryStateCallback = props.batteryStateCallback;
        this.occupancyGridCallback = props.occupancyGridCallback;
        this.moveBaseResultCallback = props.moveBaseResultCallback;
        this.playbackPosesResultCallback = props.playbackPosesResultCallback;
        this.amclPoseCallback = props.amclPoseCallback;
        this.modeCallback = props.modeCallback;
        this.isHomedCallback = props.isHomedCallback;
        this.isRunStoppedCallback = props.isRunStoppedCallback;
        this.stretchToolCallback = props.stretchToolCallback;
    }

    setOnRosConnectCallback(callback: () => Promise<void>) {
        this.onRosConnectCallback = callback;
    }

    async connect(): Promise<void> {
        console.log("Connecting to ROS...");
        this.ros = new Ros({
            url: this.rosURL,
        });

        this.ros.on("connection", async () => {
            console.log("Connected to ROS.");
            // We check that bidirectional communications with ROS are working, and
            // that some key topics have publishers (which are indicative of all
            // required nodes being loaded). This is because ROSbridge matches the
            // QoS of publishers, so without publishers there is likely to be a
            // QoS mismatch.
            let isConnected = await this.checkROSConnection();
            if (isConnected) {
                await this.onConnect();
                if (this.onRosConnectCallback)
                    await this.onRosConnectCallback();
            } else {
                console.log(
                    "Required ROS nodes are not yet loaded. Reconnecting."
                );
                this.reconnect();
            }
        });
        this.ros.on("error", (error) => {
            console.log("Error connecting to ROS:", error);
            this.reconnect();
        });

        this.ros.on("close", () => {
            console.log("Connection to ROS has been closed.");
            this.reconnect();
        });
    }

    async reconnect(interval_ms: number = 1000) {
        if (!this.rosReconnectTimerID) {
            this.rosReconnectTimerID = setTimeout(() => {
                console.log("Reconnecting to ROS...");
                this.ros.close();
                this.ros.connect(this.rosURL);
                this.rosReconnectTimerID = undefined;
            }, interval_ms);
        }
    }

    async checkROSConnection(
        required_topics: string[] = [
            "/gripper_camera/image_raw/cropped/compressed",
            "/navigation_camera/image_raw/rotated/compressed",
            // "/stretch/joint_states",
        ],
        timeout_ms: number = 5000
    ): Promise<boolean> {
        // For backwards compatibility with older versions of roslibjs, use the
        // local copy of getPublishers if the ROS object does not have it.
        let getPublishers = this.getPublishers.bind(this);
        if (this.ros.getTopics !== undefined) {
            getPublishers = this.ros.getTopics.bind(this.ros);
        }

        let numRequiredTopicsWithPublisher = 0;
        let isResolved = false;
        console.log("Checking ROS connection...");
        return new Promise(async (resolve) => {
            if (this.ros.isConnected) {
                this.ros.getTopics(
                    (result: { topics: string[]; types: string[] }) => {
                        for (let required_topic of required_topics) {
                            if (!result.topics.includes(required_topic)) {
                                console.log(
                                    "Required topic not found:",
                                    required_topic
                                );
                                isResolved = true;
                                resolve(false);
                            }
                        }
                        console.log("All required topics found.");
                        isResolved = true;
                        resolve(true);
                    },
                    (error) => {
                        console.log("Error in getting topics:", error);
                        isResolved = true;
                        resolve(false);
                    }
                );

                resolve(
                    await new Promise<boolean>((resolve) =>
                        setTimeout(() => {
                            if (!isResolved) {
                                if (
                                    numRequiredTopicsWithPublisher <
                                    required_topics.length
                                ) {
                                    console.log(
                                        "Timed out with at least one required topic not having publishers."
                                    );
                                    resolve(false);
                                }
                            }
                        }, timeout_ms)
                    )
                );
            } else {
                console.log("ROS is not connected.");
                isResolved = true;
                resolve(false);
            }
        });
    }

    async onConnect() {
        console.log("onConnect");
        this.subscribeToJointState();
        this.subscribeToJointLimits();
        this.subscribeToBatteryState();
        this.subscribeToMode();
        this.subscribeToIsHomed();
        this.subscribeToIsRunStopped();
        this.subscribeToActionResult(
            moveBaseActionName,
            this.moveBaseResultCallback,
            "Navigation canceled!",
            "Navigation succeeded!",
            "Navigation failed!"
        );
        this.createTrajectoryClient();
        this.createMoveBaseClient();
        this.createCmdVelTopic();
        this.createJointVelTopic();
        this.createUseCenterCameraService();
        this.createUseLeftCameraService();
        this.createUseRightCameraService();
        this.createExpandedGripperService();
        this.createRunStopService();
        // this.createRobotFrameTFClient();
        // this.createMapFrameTFClient();
        // this.subscribeToHeadTiltTF();
        // this.subscribeToMapTF();
        this.createHomeTheRobotService();
        this.initStretchParams();

        return Promise.resolve();
    }

    closeROSConnection() {
        this.subscriptions.forEach((topic) => {
            topic.unsubscribe();
        });
        this.ros.close();
    }

    isROSConnected() {
        return this.ros.isConnected;
    }

    subscribeToJointState() {
        const jointStateTopic: Topic<ROSJointState> = new Topic({
            ros: this.ros,
            name: "/joint_states",
            messageType: "sensor_msgs/msg/JointState",
        });
        this.subscriptions.push(jointStateTopic);

        jointStateTopic.subscribe((msg: ROSJointState) => {
            this.jointState = msg;
            let robotPose: RobotPose = rosJointStatetoRobotPose(
                this.jointState
            );
            let jointValues: ValidJointStateDict = {};
            let effortValues: ValidJointStateDict = {};
            this.jointState.name.forEach((name?: ValidJoints) => {
                let inLimits = this.inJointLimits(name);
                let collision = this.inCollision(name);
                if (inLimits) jointValues[name!] = inLimits;
                if (collision) effortValues[name!] = collision;
            });

            if (this.jointStateCallback)
                this.jointStateCallback(robotPose, jointValues, effortValues);
        });
    }

    subscribeToJointLimits() {
        const jointLimitsTopic: Topic<ROSJointState> = new Topic({
            ros: this.ros,
            name: "/joint_limits",
            messageType: "sensor_msgs/msg/JointState",
        });
        this.subscriptions.push(jointLimitsTopic);

        jointLimitsTopic.subscribe((msg: ROSJointState) => {
            msg.name.forEach((name: string, idx: number) => {
                console.log(
                    "Got joint limit for",
                    name,
                    msg.position[idx],
                    msg.velocity[idx]
                );
                // if (name == "arm_joint") name = "wrist_extension";
                this.jointLimits[name] = [msg.position[idx], msg.velocity[idx]];
            });
        });
    }

    subscribeToBatteryState() {
        const batteryStateTopic: Topic<ROSBatteryState> = new Topic({
            ros: this.ros,
            name: "/battery",
            messageType: "sensor_msgs/msg/BatteryState",
        });
        this.subscriptions.push(batteryStateTopic);

        batteryStateTopic.subscribe((msg: ROSBatteryState) => {
            if (this.batteryStateCallback) this.batteryStateCallback(msg);
        });
    }

    subscribeToMode() {
        const modeTopic: Topic = new Topic({
            ros: this.ros,
            name: "/mode",
            messageType: "std_msgs/msg/String",
        });
        this.subscriptions.push(modeTopic);

        modeTopic.subscribe((msg) => {
            if (this.modeCallback) this.modeCallback(msg.data);
        });
    }

    subscribeToIsHomed() {
        const isHomedTopic: Topic = new Topic({
            ros: this.ros,
            name: "/is_homed",
            messageType: "std_msgs/msg/Bool",
        });
        this.subscriptions.push(isHomedTopic);

        isHomedTopic.subscribe((msg) => {
            if (this.isHomedCallback) this.isHomedCallback(msg.data);
        });
    }

    subscribeToIsRunStopped() {
        let topic: Topic = new Topic({
            ros: this.ros,
            name: "is_runstopped",
            messageType: "std_msgs/msg/Bool",
        });
        this.subscriptions.push(topic);

        topic.subscribe((msg) => {
            if (this.isRunStoppedCallback) this.isRunStoppedCallback(msg.data);
        });
    }

    subscribeToVideo(props: VideoProps) {
        let topic: Topic<ROSCompressedImage> = new Topic({
            ros: this.ros,
            name: props.topicName,
            messageType: "sensor_msgs/CompressedImage",
        });
        topic.subscribe(props.callback);
        this.subscriptions.push(topic);
    }

    initStretchParams() {
        console.log("Getting stretch tool", this.ros.isConnected);
        // NOTE: This information can also come from the /tool topic.
        // However, we only need it once, so opt for a parameter.
        this.stretchToolParam = new Param({
            ros: this.ros,
            name: "/configure_video_streams_gripper:stretch_tool",
        });
        this.stretchToolParam.get((value: string) => {
            this.stretchTool = getStretchTool(value);
        });

        this.modeParam = new Param({
            ros: this.ros,
            name: "/stretch_driver:mode"
        });
    }

    getStretchTool() {
        // if (this.stretchTool == StretchTool.TABLET) {
        //     this.subscribeToTabletTF();
        // } else {
        //     this.subscribeToGripperFingerTF();
        // }
        if (this.stretchToolCallback)
            this.stretchToolCallback(this.stretchTool);
    }

    getOccupancyGrid() {
        let getMapService = new Service({
            ros: this.ros,
            name: "/map_server/map",
            serviceType: "nav2_msgs/srv/GetMap",
        });

        var request = {};
        getMapService?.callService(
            request,
            (response: { map: ROSOccupancyGrid }) => {
                if (this.occupancyGridCallback)
                    this.occupancyGridCallback(response.map);
            }
        );
    }

    getJointLimits() {
        console.log("Getting joint limits");
        let getJointLimitsService = new Service({
            ros: this.ros,
            name: "/get_joint_states",
            serviceType: "std_srvs/Trigger",
        });

        var request = {};
        getJointLimitsService.callService(
            request,
            () => {
                console.log("Got joint limits service succeeded");
            },
            (error) => {
                console.log("Got joint limits service failed", error);
            }
        );
    }

    subscribeToActionResult(
        actionName: string,
        callback?: (goalState: ActionState) => void,
        executingMsg?: string,
        cancelMsg?: string,
        successMsg?: string,
        failureMsg?: string
    ) {
        // Get the messages
        if (!executingMsg) {
            executingMsg = "Action " + actionName + "executing!";
        }
        if (!cancelMsg) {
            cancelMsg = "Action " + actionName + "canceled!";
        }
        if (!successMsg) {
            successMsg = "Action " + actionName + "succeeded!";
        }
        if (!failureMsg) {
            failureMsg = "Action " + actionName + "failed!";
        }

        // Create the topic
        let topic: Topic<ActionStatusList> = new Topic({
            ros: this.ros,
            name: actionName + "/_action/status",
            messageType: "action_msgs/msg/GoalStatusArray",
        });
        this.subscriptions.push(topic);

        // Subscribe to the topic
        topic.subscribe((msg: ActionStatusList) => {
            console.log("Got action status msg", msg);
            let status = msg.status_list.pop()?.status;
            console.log("For action ", actionName, "got status ", status);
            if (callback) {
                if (status == 2)
                    callback({
                        state: executingMsg,
                        alert_type: "info",
                    });
                else if (status == 4)
                    callback({
                        state: successMsg,
                        alert_type: "success",
                    });
                else if (status == 5)
                    callback({
                        state: cancelMsg,
                        alert_type: "error",
                    });
                else if (status == 6)
                    callback({
                        state: failureMsg,
                        alert_type: "error",
                    });
            }
        });
    }

    createTrajectoryClient() {
        this.trajectoryClient = new Action({
            ros: this.ros,
            name: followJointTrajectoryActionName,
            actionType: "control_msgs/action/FollowJointTrajectory",
        });
        console.log("created trajectory client");
    }

    createMoveBaseClient() {
        this.moveBaseClient = new Action({
            ros: this.ros,
            serverName: moveBaseActionName,
            actionName: "nav2_msgs/action/NavigateToPose",
            // timeout: 100
        });
    }

    createCmdVelTopic() {
        this.cmdVelTopic = new Topic({
            ros: this.ros,
            name: "/cmd_vel",
            messageType: "geometry_msgs/Twist",
        });
    }

    createJointVelTopic() {
        this.jointVelTopic = new Topic({
            ros: this.ros,
            name: "/joint_vel",
            messageType: "control_msgs/JointJog",
        });
    }

    createUseLeftCameraService() {
        this.useLeftCameraService = new Service({
            ros: this.ros,
            name: "/use_left_camera",
            serviceType: "std_srvs/Trigger",
        });
    }

    createUseRightCameraService() {
        this.useRightCameraService = new Service({
            ros: this.ros,
            name: "/use_right_camera",
            serviceType: "std_srvs/Trigger",
        });
    }

    createUseCenterCameraService() {
        this.useCenterCameraService = new Service({
            ros: this.ros,
            name: "/use_center_camera",
            serviceType: "std_srvs/Trigger",
        });
    }

    createHomeTheRobotService() {
        this.homeTheRobotService = new Service({
            ros: this.ros,
            name: "/home_the_robot",
            serviceType: "std_srvs/Trigger",
        });
    }

    createExpandedGripperService() {
        this.setExpandedGripperService = new Service({
            ros: this.ros,
            name: "/expanded_gripper",
            serviceType: "std_srvs/srv/SetBool",
        });
    }

    createRunStopService() {
        this.setRunStopService = new Service({
            ros: this.ros,
            name: "/runstop_the_robot",
            serviceType: "std_srvs/srv/SetBool",
        });
    }

    createRobotFrameTFClient() {
        this.robotFrameTfClient = new ROS2TFClient({
            ros: this.ros,
            fixedFrame: "base_link",
            angularThres: 0.001,
            transThres: 0.001,
            rate: 10,
        });
    }

    createMapFrameTFClient() {
        this.mapFrameTfClient = new ROS2TFClient({
            ros: this.ros,
            fixedFrame: "map",
            angularThres: 0.001,
            transThres: 0.001,
            rate: 10,
        });
    }

    useLeftCamera() {
        this.useLeftCameraService?.callService({}, () => {
            console.log("Successfully switched to left camera")
        });
    }

    useRightCamera() {
        this.useRightCameraService?.callService({}, () => {
            console.log("Successfully switched to right camera")
        });
    }

    useCenterCamera() {
        this.useCenterCameraService?.callService({}, () => {
            console.log("Successfully switched to center camera")
        });
    }

    subscribeToGripperFingerTF() {
        this.robotFrameTfClient?.subscribe(
            "gripper_finger_left_link",
            (transform) => {
                this.linkGripperFingerLeftTF = transform;
            }
        );
    }

    subscribeToWristYawTF() {
        this.robotFrameTfClient?.subscribe("wrist_yaw_link", (transform) => {
            this.linkWristYawTF = transform;
        });
    }

    subscribeToHeadTiltTF() {
        this.robotFrameTfClient?.subscribe("head_tilt_link", (transform) => {
            this.linkHeadTiltTF = transform;
        });
    }

    subscribeToMapTF() {
        this.mapFrameTfClient?.subscribe("base_link", (transform) => {
            if (this.amclPoseCallback) this.amclPoseCallback(transform);
        });
    }

    setExpandedGripper(toggle: boolean) {
        var request = { data: toggle };
        this.setExpandedGripperService?.callService(
            request,
            (response: boolean) => {
                response
                    ? console.log(
                        "Successfully set expanded gripper to",
                        toggle
                    )
                    : console.log("Failed to set expanded gripper to", toggle);
            }
        );
    }

    setRunStop(toggle: boolean) {
        var request = { data: toggle };
        this.setRunStopService?.callService(request, (response: boolean) => { });
    }

    /**
     * In navigation mode, you can send position commands to the arm and
     * velocity commands to the base.
     */
    switchToNavigationMode() {
        if (robotMode === "navigation") return;
        this.modeParam.set("navigation", () => {
            robotMode = "navigation";
            console.log("Switched to navigation mode");
        });
    }

    /**
     * In position mode, you can send position commands to the arm and
     * position commands to the base.
     */
    switchToPositionMode = () => {
        if (robotMode === "position") return;
        this.modeParam.set("position", () => {
            robotMode = "position";
            console.log("Switched to position mode");
        });
    };

    /**
     * In velocity mode, you can send velocity commands to the arm and base.
     */
    switchToVelocityMode = () => {
        if (robotMode === "velocity") return;
        this.modeParam.set("velocity", () => {
            robotMode = "velocity";
            console.log("Switched to velocity mode");
        });
    };

    /**
     * Ask the robot to home itself.
     */
    homeTheRobot() {
        var request = {};
        this.homeTheRobotService!.callService(request, () => {
            console.log("Homing complete");
        });
    }

    executeBaseVelocity = (props: {
        linVelX: number;
        linVelY: number;
        angVel: number;
    }): void => {
        this.switchToVelocityMode();
        this.stopExecution();
        let twist = {
            linear: {
                x: props.linVelX,
                y: props.linVelY,
                z: 0,
            },
            angular: {
                x: 0,
                y: 0,
                z: props.angVel,
            },
        };

        if (!this.cmdVelTopic) throw "cmdVelTopic is undefined";
        console.log("Publishing base velocity twist message");
        this.cmdVelTopic.publish(twist);
    };

    setJointVelocity(jointName: ValidJoints, velocity: number) {
        this.switchToVelocityMode();
        this.stopExecution();
        let jointVelocities = {
            joint_names: [jointName],
            velocities: [velocity],
        };
        if (!this.jointVelTopic) throw "jointVelTopic is undefined";
        this.jointVelTopic.publish(jointVelocities);
    }

    makeIncrementalMoveGoal(
        jointName: ValidJoints,
        jointValueInc: number
    ): Goal | undefined {
        if (!this.jointState) throw "jointState is undefined";
        let newJointValue = this.getJointValue(jointName);
        // Paper over Hello's fake joints
        if (
            jointName === "translate_mobile_base" ||
            jointName === "rotate_mobile_base"
        ) {
            // These imaginary joints are floating, always have 0 as their reference
            newJointValue = 0;
        }

        // let collision = this.inCollision({
        //     jointStateMessage: this.jointState,
        //     jointName: jointName,
        // });
        // let collisionIndex = jointValueInc <= 0 ? 0 : 1;
        // if (jointName === "wrist_yaw_joint") {
        //     collisionIndex = jointValueInc <= 0 ? 1 : 0;
        // }
        // Negative joint increment is for lower/retract/wrist out
        // Positive joint increment is for lift/extend/wrist in
        // let index = jointValueInc <= 0 ? 0 : 1;
        // If request to move the joint in the direction of collision, cancel movement
        // if (collision[collisionIndex]) return;

        newJointValue = newJointValue + jointValueInc;

        // Make sure new joint value is within limits
        // if (jointName in this.jointLimits) {
        //     let inLimits = this.inJointLimitsHelper(newJointValue, jointName);
        //     if (!inLimits) throw "invalid joint name";
        //     // console.log(newJointValue, this.jointLimits[jointName]![index], inLimits[index])
        //     if (!inLimits[index])
        //         newJointValue = this.jointLimits[jointName]![index];
        // }

        let pose = { [jointName]: newJointValue };
        if (!this.trajectoryClient) throw "trajectoryClient is undefined";
        return this.makePoseGoal(pose);
    }

    makeMoveBaseGoal(pose: ROSPose) {
        if (!this.moveBaseClient) throw "moveBaseClient is undefined";

        let newGoal = {
            pose: {
                header: {
                    frame_id: "map",
                },
                pose: pose,
            },
        };

        return newGoal;
    }


    makePoseGoal(pose: RobotPose) {
        let jointNames: ValidJoints[] = [];
        let jointPositions: number[] = [];
        for (let key in pose) {
            jointNames.push(key as ValidJoints);
            jointPositions.push(pose[key as ValidJoints]!);
        }

        console.log(jointNames, jointPositions);
        if (!this.trajectoryClient) throw "trajectoryClient is undefined";
        let newGoal = {
            trajectory: {
                header: {
                    stamp: {
                        secs: 0,
                        nsecs: 0,
                    },
                },
                joint_names: jointNames,
                points: [
                    {
                        positions: jointPositions,
                        // The following might causing the jumpiness in continuous motions
                        time_from_start: {
                            secs: 1,
                            nsecs: 0,
                        },
                    },
                ],
            },
        };

        return newGoal;
    }

    makePoseGoals(poses: RobotPose[]) {
        let jointNames: ValidJoints[] = [];
        for (let key in poses[0]) {
            jointNames.push(key as ValidJoints);
        }

        let points: any = [];
        let jointPositions: number[] = [];
        poses.forEach((pose, index) => {
            jointPositions = [];
            for (let key in pose) {
                jointPositions.push(pose[key as ValidJoints]!);
            }
            points.push({
                positions: jointPositions,
                time_from_start: {
                    secs: 10,
                    nsecs: 0,
                },
            });
        });

        if (!this.trajectoryClient) throw "trajectoryClient is undefined";
        let newGoal = {
            trajectory: {
                header: {
                    stamp: {
                        secs: 0,
                        nsecs: 0,
                    },
                },
                joint_names: jointNames,
                points: points,
            },
        };

        return newGoal;
    }

    executePoseGoal(pose: RobotPose) {
        console.log("executing pose goal");
        this.switchToNavigationMode();
        this.stopExecution();
        this.poseGoal = this.makePoseGoal(pose);
        console.log("execute: ", pose);
        this.poseGoalID = this.trajectoryClient.sendGoal(
            this.poseGoal,
            (result) => {
                console.log(
                    "Result for action goal on " +
                    this.trajectoryClient.name +
                    ": " +
                    result.error_code
                );
                if (result.error_code == 0) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Success,
                        alert_type: "info",
                    });
                }
            },
            (feedback) => {
                console.log(
                    "Feedback for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    feedback
                );
            },
            (error) => {
                let error_code = JSON.parse(error.slice(error.indexOf("{"))).error_code;
                console.log(
                    "Error for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    error
                );
                if (error_code == 0) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Cancel,
                        alert_type: "error",
                    });
                } else if (error_code == -4) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Fail,
                        alert_type: "error",
                    });
                }
            }
        );
    }

    async executePoseGoals(poses: RobotPose[], index: number) {
        this.switchToNavigationMode();
        // this.stopExecution();
        this.poseGoal = this.makePoseGoals(poses);
        this.playbackPosesResultCallback({
            state: MovementState.Executing,
            alert_type: "info",
        })

        this.poseGoalID = this.trajectoryClient.sendGoal(
            this.poseGoal,
            (result) => {
                console.log(
                    "Result for action goal on " +
                    this.trajectoryClient.name +
                    ": " +
                    result.error_code
                );
                if (result.error_code == 0) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Success,
                        alert_type: "info",
                    });
                }
            },
            (feedback) => {
                console.log(
                    "Feedback for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    feedback
                );
            },
            (error) => {
                let error_code = JSON.parse(error.slice(error.indexOf("{"))).error_code;
                console.log(
                    "Error for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    error
                );
                if (error_code == 0) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Cancel,
                        alert_type: "error",
                    });
                } else if (error_code == -4) {
                    this.playbackPosesResultCallback({
                        state: MovementState.Fail,
                        alert_type: "error",
                    });
                }
            }
        );
    }

    executeMoveBaseGoal(pose: ROSPose) {
        // this.switchToNavigationMode();
        // this.stopExecution()
        this.moveBaseGoal = this.makeMoveBaseGoal(pose);
        this.moveBaseClient.sendGoal(this.moveBaseGoal);
    }

    executeIncrementalMove(jointName: ValidJoints, increment: number) {
        // this.switchToNavigationMode();
        // this.stopAutonomousClients();
        this.poseGoal = this.makeIncrementalMoveGoal(jointName, increment);
        console.log("incremental: ", jointName, increment, this.poseGoal);
        this.trajectoryClient.sendGoal(
            this.poseGoal,
            (result) => {
                console.log(
                    "Result for action goal on " +
                    this.trajectoryClient.name +
                    ": " +
                    result.error_string
                );
            },
            (feedback) => {
                console.log(
                    "Feedback for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    feedback
                );
            }
        );
    }

    stopExecution(stop_trajectory_client: boolean = false) {
        if (stop_trajectory_client) this.stopTrajectoryClient();
        this.stopAutonomousClients();
    }

    stopAutonomousClients() {
        this.stopMoveBaseClient();
    }

    stopTrajectoryClient() {
        if (!this.trajectoryClient) throw "trajectoryClient is undefined";
        if (this.poseGoal) {
            this.trajectoryClient.cancelGoal(this.poseGoalID);
            this.poseGoal = undefined;
            this.playbackPosesResultCallback({
                state: MovementState.Cancel,
                alert_type: "error",
            });
        }
    }

    stopMoveBaseClient() {
        if (!this.moveBaseClient) throw "moveBaseClient is undefined";
        if (this.moveBaseGoal) {
            this.moveBaseClient.cancelGoal();
            this.moveBaseGoal = undefined;
        }
    }

    getJointValue(jointName: ValidJoints): number {
        if (
            jointName === "translate_mobile_base" ||
            jointName === "rotate_mobile_base"
        ) {
            return 0;
        }

        let jointIndex = this.jointState.name.indexOf(jointName);
        return this.jointState.position[jointIndex];
    }


    inJointLimits(jointName: ValidJoints) {
        let jointValue = this.getJointValue(jointName);
        return this.inJointLimitsHelper(jointValue, jointName);
    }

    inJointLimitsHelper(jointValue: number, jointName: ValidJoints) {
        let jointLimits = this.jointLimits[jointName];
        if (!jointLimits) return;

        var eps = 0.03;
        let inLimits: [boolean, boolean] = [true, true];
        inLimits[0] = jointValue - eps >= jointLimits[0]; // Lower joint limit
        inLimits[1] = jointValue + eps <= jointLimits[1]; // Upper joint limit
        return inLimits;
    }

    inCollision(jointName: ValidJoints) {
        let inCollision: [boolean, boolean] = [false, false];
        // TODO: This formulation needs to be changed, because effort values are
        // robot-specific and change based on whether the robot is plugged in or not,
        // mechanical factors (e.g., an old cable), etc. Thus, a single threshold
        // will not work across all robots.
        const MAX_EFFORTS: { [key in ValidJoints]?: [number, number] } = {
            head_tilt_joint: [-50, 50],
            head_pan_joint: [-50, 50],
            wrist_extension: [-40, 40],
            lift_joint: [0, 70],
            // "wrist_yaw_joint": [-10, 10],
            // "wrist_pitch_joint": [-10, 10],
            // "wrist_roll_joint": [-10, 10],
        };

        if (!(jointName in MAX_EFFORTS)) return inCollision;

        let jointIndex = this.jointState.name.indexOf(jointName);
        // In collision if joint is applying more than 50% effort when moving downward/inward/backward
        inCollision[0] =
            this.jointState.effort[jointIndex] < MAX_EFFORTS[jointName]![0];
        // In collision if joint is applying more than 50% effort when moving upward/outward/forward
        inCollision[1] =
            this.jointState.effort[jointIndex] > MAX_EFFORTS[jointName]![1];

        return inCollision;
    }

    /**
     * Copied from https://github.com/hello-vinitha/roslibjs/pull/1 and
     * https://github.com/RobotWebTools/roslibjs/pull/760 , included here for
     * backwards compatibility.
     */
    getPublishers(
        topic: string,
        callback: (publishers: string[]) => void,
        failedCallback: (message: any) => void
    ) {
        var publishersClient = new Service({
            ros: this.ros,
            name: "/rosapi/publishers",
            serviceType: "rosapi_msgs/srv/Publishers",
        });

        var request = { topic: topic };
        if (typeof failedCallback === "function") {
            publishersClient.callService(
                request,
                function (result: any) {
                    callback(result.publishers);
                },
                failedCallback
            );
        } else {
            publishersClient.callService(request, function (result) {
                callback(result.publishers);
            });
        }
    }
}
