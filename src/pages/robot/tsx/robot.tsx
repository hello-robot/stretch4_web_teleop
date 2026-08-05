import React from "react";
import {
    Action,
    Goal,
    Message,
    Param,
    Ros,
    ROS2TFClient,
    Service,
    Topic,
    Transform,
} from "roslib";
import {
    ActionState,
    ActionStatusList,
    DiagnosticArray,
    getStretchTool,
    JOINT_VELOCITIES,
    ROSBatteryState,
    ROSCompressedImage,
    ROSJointState,
    ROSOccupancyGrid,
    ROSOdometry,
    ROSPose,
    StretchTool,
    ValidJoints,
    VideoProps,
} from "shared/util";
import {
    RobotPose,
    rosJointStatetoRobotPose,
    ValidJointStateDict
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

// ROS 2 action_msgs/msg/GoalStatus values.
// Reference: https://github.com/ros2/rcl_interfaces/blob/humble/action_msgs/msg/GoalStatus.msg
export enum GoalStatus {
    STATUS_UNKNOWN = 0,
    STATUS_ACCEPTED = 1,
    STATUS_EXECUTING = 2,
    STATUS_CANCELING = 3,
    STATUS_SUCCEEDED = 4,
    STATUS_CANCELED = 5,
    STATUS_ABORTED = 6,
}

// Names of ROS actions
const moveBaseActionName = "/navigate_to_pose";
const followJointTrajectoryActionName = "/follow_joint_trajectory";

// Pose-proximity arrival (primary completion when rosbridge action status/result fail).
// Slightly above Nav2 xy_goal_tolerance (0.25m); streak avoids a single noisy TF sample.
const MOVE_BASE_GOAL_XY_TOL_M = 0.35;
const MOVE_BASE_GOAL_INSIDE_STREAK = 5;

export class Robot extends React.Component {
    private ros: Ros;
    private readonly rosURL = "wss://localhost:9090";
    private rosReconnectTimerID?: ReturnType<typeof setTimeout>;
    private onRosConnectCallback?: () => Promise<void>;
    private jointLimits: { [key in ValidJoints]?: [number, number] } = {};
    private diagnosticJointLimits: { [key in ValidJoints]?: [boolean, boolean] } = {};
    private jointState?: ROSJointState;
    private poseGoal?: Goal;
    private poseGoalID?: string;
    private isRunStopped?: boolean;
    private moveBaseGoal?: Goal;
    private moveBaseGoalID?: string;
    /**
     * Nav2 keeps SUCCEEDED entries in /_action/status forever. We only treat a
     * terminal status as "our" result after we've seen an in-progress status
     * (or feedback) for the current sendGoal session.
     */
    private moveBaseStatusWatching = false;
    private moveBaseStatusSeenActive = false;
    private moveBaseStatusLastEmitted?: number;
    /** Count of terminal statuses when this goal session began (stale SUCCEEDED pile). */
    private moveBaseTerminalBaseline?: number;
    /** Goal XY for pose-proximity arrival detection. */
    private moveBaseGoalXY?: { x: number; y: number };
    private moveBaseInsideTolStreak = 0;
    private trajectoryClient?: Action;
    private moveBaseClient?: Action;
    private cmdVelTopic?: Topic;
    private jointVelTopic?: Topic;
    private useCenterCameraService?: Service;
    private useLeftCameraService?: Service;
    private useRightCameraService?: Service;
    private setExpandedGripperService?: Service;
    private setRunStopService?: Service;
    private toggleBaseOnlyCollisionService?: Service;
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
    private odomCallback: (odom: ROSOdometry) => void;
    private moveBaseResultCallback: (goalState: ActionState) => void;
    private playbackPosesResultCallback: (goalState: ActionState) => void;
    private amclPoseCallback: (pose: Transform) => void;
    private modeCallback: (mode: string) => void;
    private isHomedCallback: (isHomed: boolean) => void;
    private isRunStoppedCallback: (isRunStopped: boolean) => void;
    private stretchToolCallback: (value: string) => void;
    private leaseStatusCallback: (holder: string, isDriverHolding: boolean) => void;
    private subscriptions: Topic[] = [];
    private stretchToolParam: Param;
    private modeParam: Param;
    private homeTheRobotService?: Service;
    private seedLocalizationService?: Service;
    private stretchTool: StretchTool;

    constructor(props: {
        jointStateCallback: (
            robotPose: RobotPose,
            jointValues: ValidJointStateDict,
            effortValues: ValidJointStateDict
        ) => void;
        batteryStateCallback: (batteryState: ROSBatteryState) => void;
        occupancyGridCallback: (occupancyGrid: ROSOccupancyGrid) => void;
        odomCallback: (odom: ROSOdometry) => void;
        moveBaseResultCallback: (goalState: ActionState) => void;
        playbackPosesResultCallback: (goalState: ActionState) => void;
        amclPoseCallback: (pose: Transform) => void;
        modeCallback: (mode: string) => void;
        isHomedCallback: (isHomed: boolean) => void;
        isRunStoppedCallback: (isRunStopped: boolean) => void;
        stretchToolCallback: (value: string) => void;
        leaseStatusCallback: (holder: string, isDriverHolding: boolean) => void;
    }) {
        super(props);
        this.jointStateCallback = props.jointStateCallback;
        this.batteryStateCallback = props.batteryStateCallback;
        this.occupancyGridCallback = props.occupancyGridCallback;
        this.odomCallback = props.odomCallback;
        this.moveBaseResultCallback = (goalState) => {
            if (goalState.state !== "Navigation executing!") {
                this.moveBaseGoalID = undefined;
                this.moveBaseGoal = undefined;
                this.moveBaseStatusWatching = false;
                this.moveBaseStatusSeenActive = false;
                this.moveBaseTerminalBaseline = undefined;
                this.moveBaseGoalXY = undefined;
                this.moveBaseInsideTolStreak = 0;
            }
            props.moveBaseResultCallback(goalState);
        };
        this.playbackPosesResultCallback = props.playbackPosesResultCallback;
        this.amclPoseCallback = props.amclPoseCallback;
        this.modeCallback = props.modeCallback;
        this.isHomedCallback = props.isHomedCallback;
        this.isRunStoppedCallback = props.isRunStoppedCallback;
        this.stretchToolCallback = props.stretchToolCallback;
        this.leaseStatusCallback = props.leaseStatusCallback;
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
        const collisionMonitorActive = await this.isCollisionMonitorActive();

        this.subscribeToJointState();
        this.subscribeToJointLimits();
        this.subscribeToBatteryState();
        this.subscribeToOdom();
        this.subscribeToMode();
        this.subscribetoJointStateDiagnostics();
        this.subscribeToLeaseHolder();
        this.createTrajectoryClient();
        this.createMoveBaseClient();
        // Primary completion signal: rosbridge sendGoal result callbacks are
        // unreliable; Nav2 /_action/status is the durable path for Stop UI.
        this.subscribeToActionResult(
            moveBaseActionName,
            this.moveBaseResultCallback,
            "Navigation executing!",
            "Navigation canceled!",
            "Navigation succeeded!",
            "Navigation failed!",
        );

        this.createCmdVelTopic(collisionMonitorActive);
        this.createJointVelTopic();
        this.createUseCenterCameraService();
        this.createUseLeftCameraService();
        this.createUseRightCameraService();
        this.createExpandedGripperService();
        this.createRunStopService();
        this.createToggleBaseOnlyCollisionService();
        this.toggleBaseOnlyCollision(true);
        // this.createRobotFrameTFClient();
        // this.createMapFrameTFClient();
        // this.subscribeToHeadTiltTF();
        // this.subscribeToMapTF();
        this.createHomeTheRobotService();
        this.createSeedLocalizationService();
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
            robotPose["arm_joint"] = this.getJointValue("arm_joint");
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

    subscribeToOdom() {
        const odomTopic: Topic<ROSOdometry> = new Topic({
            ros: this.ros,
            name: "/wheel_odom",
            messageType: "nav_msgs/msg/Odometry",
        });
        this.subscriptions.push(odomTopic);

        odomTopic.subscribe((msg: ROSOdometry) => {
            if (this.odomCallback) this.odomCallback(msg);
        });
    }

    subscribeToMode() {
        const modeTopic: Topic = new Topic({
            ros: this.ros,
            name: "/mode",
            messageType: "std_msgs/msg/String",
        });
        this.subscriptions.push(modeTopic);

        modeTopic.subscribe((msg: any) => {
            robotMode = msg.data;
            if (this.modeCallback) this.modeCallback(msg.data);
        });
    }

    subscribeToLeaseHolder() {
        const leaseHolderTopic: Topic = new Topic({
            ros: this.ros,
            name: "/server_lease_holder",
            messageType: "diagnostic_msgs/msg/DiagnosticStatus",
        });
        this.subscriptions.push(leaseHolderTopic);

        leaseHolderTopic.subscribe((message: Message) => {
            const status = message as any;
            let leaseHolder = "none";
            if (status && status.values) {
                const holderPair = status.values.find((pair: any) => pair.key === "lease_holder");
                if (holderPair) {
                    leaseHolder = holderPair.value;
                }
            }
            const isDriverHolding = leaseHolder === "ros2_driver" || leaseHolder === "None" || leaseHolder === "none";
            if (this.leaseStatusCallback) {
                this.leaseStatusCallback(leaseHolder, isDriverHolding);
            }
        });
    }

    subscribetoJointStateDiagnostics() {
        const jointStateDiagnosticsTopic: Topic = new Topic({
            ros: this.ros,
            name: "/joint_states_diagnostics",
            messageType: "diagnostic_msgs/msg/DiagnosticArray",
        });
        this.subscriptions.push(jointStateDiagnosticsTopic);
        jointStateDiagnosticsTopic.subscribe((message: Message) => {
            let msg = message as DiagnosticArray;
            msg.status.forEach((status) => {
                if (status.name == "is_runstopped") {
                    let isRunStopped = status.values.every((v) => v.value == 'True');
                    if (this.isRunStoppedCallback) this.isRunStoppedCallback(isRunStopped);
                }
                if (status.name == "is_homed") {
                    let isHomed = status.values.every((v) => v.value == 'True');
                    if (this.isHomedCallback) this.isHomedCallback(isHomed);
                }
                if (status.name == "at_limit") {
                    status.values.forEach((v) => {
                        let jointName = v.key as ValidJoints;
                        let valStr = v.value;
                        let isPos = valStr.includes("'pos': True") || valStr.includes('"pos": true') || valStr.includes("'pos': true") || valStr.includes('"pos": True');
                        let isNeg = valStr.includes("'neg': True") || valStr.includes('"neg": true') || valStr.includes("'neg': true") || valStr.includes('"neg": True');
                        this.diagnosticJointLimits[jointName] = [!isNeg, !isPos];
                    });
                }
            });
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
                this.subscribeToMapTF();
                if (this.occupancyGridCallback)
                    this.occupancyGridCallback(response.map);
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
            const statusList = msg.status_list;
            if (!statusList?.length || !callback) {
                return;
            }

            if (actionName === moveBaseActionName) {
                this.handleMoveBaseActionStatus(
                    statusList,
                    callback,
                    executingMsg!,
                    cancelMsg!,
                    successMsg!,
                    failureMsg!,
                );
                return;
            }

            // Generic (non-move-base) path: newest status only.
            const status = statusList[statusList.length - 1]?.status;
            console.log("For action ", actionName, "got status ", status);
            if (status === undefined) {
                return;
            }
            if (status == GoalStatus.STATUS_EXECUTING)
                callback({
                    state: executingMsg,
                    alert_type: "info",
                });
            else if (status == GoalStatus.STATUS_SUCCEEDED)
                callback({
                    state: successMsg,
                    alert_type: "success",
                });
            else if (status == GoalStatus.STATUS_CANCELED)
                callback({
                    state: cancelMsg,
                    alert_type: "error",
                });
            else if (status == GoalStatus.STATUS_ABORTED)
                callback({
                    state: failureMsg,
                    alert_type: "error",
                });
        });
    }

    /**
     * Interpret Nav2 /navigate_to_pose/_action/status without treating a pile of
     * historical SUCCEEDED entries as the current goal finishing.
     */
    private handleMoveBaseActionStatus(
        statusList: { status: number }[],
        callback: (goalState: ActionState) => void,
        executingMsg: string,
        cancelMsg: string,
        successMsg: string,
        failureMsg: string,
    ) {
        if (!this.moveBaseStatusWatching) {
            return;
        }

        // rosbridge may deliver status as string; coerce before compares.
        const statuses = statusList.map((entry) => Number(entry.status));
        const terminalCount = statuses.filter(
            (status) =>
                status === GoalStatus.STATUS_SUCCEEDED ||
                status === GoalStatus.STATUS_CANCELED ||
                status === GoalStatus.STATUS_ABORTED,
        ).length;
        if (this.moveBaseTerminalBaseline === undefined) {
            this.moveBaseTerminalBaseline = terminalCount;
        }

        const hasAccepted = statuses.includes(GoalStatus.STATUS_ACCEPTED);
        const hasExecuting = statuses.includes(GoalStatus.STATUS_EXECUTING);
        const hasCanceling = statuses.includes(GoalStatus.STATUS_CANCELING);

        if (hasAccepted || hasExecuting || hasCanceling) {
            this.moveBaseStatusSeenActive = true;
            if (
                hasExecuting &&
                this.moveBaseStatusLastEmitted !== GoalStatus.STATUS_EXECUTING
            ) {
                console.log(
                    "For action ",
                    moveBaseActionName,
                    "got status ",
                    GoalStatus.STATUS_EXECUTING,
                );
                callback({
                    state: executingMsg,
                    alert_type: "info",
                });
                this.moveBaseStatusLastEmitted = GoalStatus.STATUS_EXECUTING;
            }
            return;
        }

        // Fallback when rosbridge never shows EXECUTING: a new terminal entry
        // appeared after this goal was sent.
        if (
            !this.moveBaseStatusSeenActive &&
            terminalCount > (this.moveBaseTerminalBaseline ?? 0)
        ) {
            this.moveBaseStatusSeenActive = true;
        }

        // No in-progress goals. Ignore stale SUCCEEDED until we've seen ours active.
        if (!this.moveBaseStatusSeenActive) {
            return;
        }

        // Prefer the newest terminal status in the list.
        let terminal: number | undefined;
        for (let i = statuses.length - 1; i >= 0; i--) {
            const status = statuses[i];
            if (
                status === GoalStatus.STATUS_SUCCEEDED ||
                status === GoalStatus.STATUS_CANCELED ||
                status === GoalStatus.STATUS_ABORTED
            ) {
                terminal = status;
                break;
            }
        }
        if (terminal === undefined) {
            return;
        }
        if (terminal === this.moveBaseStatusLastEmitted) {
            return;
        }

        console.log(
            "For action ",
            moveBaseActionName,
            "got status ",
            terminal,
        );
        if (terminal === GoalStatus.STATUS_SUCCEEDED) {
            callback({
                state: successMsg,
                alert_type: "success",
            });
            this.toggleBaseOnlyCollision(true);
        } else if (terminal === GoalStatus.STATUS_CANCELED) {
            callback({
                state: cancelMsg,
                alert_type: "error",
            });
            this.toggleBaseOnlyCollision(true);
        } else if (terminal === GoalStatus.STATUS_ABORTED) {
            callback({
                state: failureMsg,
                alert_type: "error",
            });
            this.toggleBaseOnlyCollision(true);
        }
        this.moveBaseStatusLastEmitted = terminal;
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
            name: moveBaseActionName,
            actionType: "nav2_msgs/action/NavigateToPose",
            // timeout: 100
        });
    }

    createCmdVelTopic(use_vel_nav: boolean = true) {
        this.cmdVelTopic = new Topic({
            ros: this.ros,
            name: use_vel_nav ? "/cmd_vel_nav" : "/cmd_vel",
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

    createSeedLocalizationService() {
        this.seedLocalizationService = new Service({
            ros: this.ros,
            name: "/seed_localization",
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

    createToggleBaseOnlyCollisionService() {
        this.toggleBaseOnlyCollisionService = new Service({
            ros: this.ros,
            name: "/joystick_control",
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
        this.createMapFrameTFClient();
        this.mapFrameTfClient?.subscribe("base_link", (transform) => {
            if (this.amclPoseCallback) this.amclPoseCallback(transform);
            this.maybeCompleteMoveBaseByProximity(transform);
        });
    }

    /**
     * Primary AutoNav completion path: emit success when map→base_link stays
     * within XY tolerance of the goal. Independent of rosbridge action status.
     */
    private maybeCompleteMoveBaseByProximity(transform: Transform) {
        if (!this.moveBaseStatusWatching || !this.moveBaseGoalXY) {
            return;
        }
        const dx = transform.translation.x - this.moveBaseGoalXY.x;
        const dy = transform.translation.y - this.moveBaseGoalXY.y;
        const dist = Math.hypot(dx, dy);
        if (dist > MOVE_BASE_GOAL_XY_TOL_M) {
            this.moveBaseInsideTolStreak = 0;
            return;
        }
        this.moveBaseInsideTolStreak += 1;
        if (this.moveBaseInsideTolStreak < MOVE_BASE_GOAL_INSIDE_STREAK) {
            return;
        }
        console.log(
            "Navigation succeeded via pose proximity:",
            dist.toFixed(3),
            "m",
        );
        this.moveBaseResultCallback({
            state: "Navigation succeeded!",
            alert_type: "success",
        });
        this.toggleBaseOnlyCollision(true);
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

    toggleBaseOnlyCollision(bool: boolean) {
        console.log("toggleBaseOnlyCollision called with value:", bool);
        var request = { data: bool };
        this.toggleBaseOnlyCollisionService?.callService(
            request,
            (response: boolean) => {
                response
                    ? console.log(
                        "Successfully toggled base only collision to",
                        bool
                    )
                    : console.log("Failed to toggle base only collision to", bool);
            }
        );
    }


    /**
     * In navigation mode, you can send position commands to the arm and
     * velocity commands to the base.
     */
    switchToNavigationMode(): Promise<void> {
        return new Promise((resolve) => {
            if (robotMode === "navigation") {
                resolve();
                return;
            }
            this.modeParam.set("navigation", () => {
                robotMode = "navigation";
                console.log("Switched to navigation mode");
                resolve();
            });
        })
    }

    /**
     * In position mode, you can send position commands to the arm and
     * position commands to the base.
     */
    switchToPositionMode = (): Promise<void> => {
        return new Promise((resolve) => {
            if (robotMode === "position") {
                resolve();
                return;
            }
            this.modeParam.set("position", () => {
                robotMode = "position";
                console.log("Switched to position mode");
                resolve();
            });
        });
    };

    /**
     * In velocity mode, you can send velocity commands to the arm and base.
     */
    switchToVelocityMode = (): Promise<void> => {
        return new Promise((resolve) => {
            if (robotMode === "velocity") {
                resolve();
                return;
            }
            this.modeParam.set("velocity", () => {
                robotMode = "velocity";
                console.log("Switched to velocity mode");
                resolve();
            });
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

    /**
     * Ask the robot to seed its localization.
     */
    seedLocalization() {
        var request = {};
        this.seedLocalizationService!.callService(request, () => {
            console.log("Seed localization complete");
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

    async setJointVelocity(jointName: ValidJoints, velocity: number) {
        await this.switchToVelocityMode();
        this.stopExecution();
        let jointVelocities = {
            joint_names: [jointName],
            velocities: [velocity],
            duration: 0.05  // multiple of a heartbeat (0.025s)
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


    makePoseGoal(pose: RobotPose, minDuration: number = 0.5) {
        const allJointNames = Object.keys(pose) as ValidJoints[];
        if (allJointNames.length === 0) throw new Error("Pose object cannot be empty");

        let maxDuration = minDuration;
        const jointNames: ValidJoints[] = [];
        const jointPositions: number[] = [];

        for (let key in pose) {
            const jointName = key as ValidJoints;
            let targetPos = pose[jointName]!;

            try {
                const currentPos = this.getJointValue(jointName);
                if (currentPos !== undefined && !isNaN(currentPos)) {
                    const distance = Math.abs(targetPos - currentPos);
                    const velocityLimit = JOINT_VELOCITIES[jointName] || 0.1; // fallback speed

                    if (velocityLimit > 0) {
                        const jointDuration = distance / velocityLimit;
                        if (!isNaN(jointDuration) && jointDuration > maxDuration) {
                            maxDuration = jointDuration;
                        }
                    }
                }
            } catch (e) {
                console.warn(`Could not compute dynamic duration for ${jointName}:`, e);
            }
            jointNames.push(jointName);
            jointPositions.push(targetPos);
        }

        if (jointNames.length === 0) {
            // Defensive fallback: if all joints are skipped, include the first one to avoid empty goal errors
            const firstKey = Object.keys(pose)[0] as ValidJoints;
            jointNames.push(firstKey);
            jointPositions.push(pose[firstKey]!);
        }

        // Safe nanosecond calculation
        let secs = Math.floor(maxDuration);
        let nsecs = Math.round((maxDuration - secs) * 1e9);
        if (nsecs >= 1e9) {
            secs += 1;
            nsecs = 0;
        }

        console.log("Calculated synchronized trajectory duration:", maxDuration, "secs:", secs, "nsecs:", nsecs);

        if (!this.trajectoryClient) throw new Error("trajectoryClient is undefined");

        return {
            trajectory: {
                header: {
                    stamp: { secs: 0, nsecs: 0 }, // Execute immediately
                },
                joint_names: jointNames,
                points: [
                    {
                        positions: jointPositions,
                        time_from_start: { secs, nsecs },
                    },
                ],
            },
        };
    }

    makePoseGoals(poses: RobotPose[], minSegmentDuration: number = 0.5) {
        if (!poses || poses.length === 0) {
            throw new Error("Poses array cannot be empty");
        }

        // Standardize joint list using the union of keys or the first pose's keys
        const jointNames = Object.keys(poses[0]) as ValidJoints[];
        const points: any[] = [];
        let cumulativeTime = 0.0;

        // keep track of cumulative duration for timestamps for each point
        poses.forEach((pose, index) => {
            let segmentDuration = minSegmentDuration;
            const jointPositions: number[] = [];

            jointNames.forEach((name) => {
                if (index === 0) {
                    // First pose: evaluate vs. live state
                    const currentPos = this.getJointValue(name);
                    const targetPos = pose[name] !== undefined ? pose[name]! : currentPos;
                    jointPositions.push(targetPos);

                    if (targetPos !== undefined && currentPos !== undefined && !isNaN(currentPos)) {
                        const distance = Math.abs(targetPos - currentPos);
                        const velocityLimit = JOINT_VELOCITIES[name] || 0.1;
                        if (velocityLimit > 0) {
                            segmentDuration = Math.max(segmentDuration, distance / velocityLimit);
                        }
                    }
                } else {
                    // Subsequent poses: evaluate vs. previous point's recorded target position
                    const prevPos = points[index - 1].positions[jointNames.indexOf(name)];
                    const targetPos = pose[name] !== undefined ? pose[name]! : prevPos;
                    jointPositions.push(targetPos);

                    if (targetPos !== undefined && prevPos !== undefined) {
                        const distance = Math.abs(targetPos - prevPos);
                        const velocityLimit = JOINT_VELOCITIES[name] || 0.1;
                        if (velocityLimit > 0) {
                            segmentDuration = Math.max(segmentDuration, distance / velocityLimit);
                        }
                    }
                }
            });

            cumulativeTime += segmentDuration;

            // Safe nanosecond calculation
            let secs = Math.floor(cumulativeTime);
            let nsecs = Math.round((cumulativeTime - secs) * 1e9);
            if (nsecs >= 1e9) {
                secs += 1;
                nsecs = 0;
            }

            points.push({
                positions: jointPositions,
                time_from_start: { secs, nsecs },
            });
        });

        if (!this.trajectoryClient) throw new Error("trajectoryClient is undefined");

        return {
            trajectory: {
                header: {
                    stamp: { secs: 0, nsecs: 0 },
                },
                joint_names: jointNames,
                points: points,
            },
        };
    }

    isAlreadyAtPose(pose: RobotPose, tolerance: number = 0.01): boolean {
        if (!this.jointState) {
            console.log("isAlreadyAtPose: No jointState received yet.");
            return false;
        }
        console.log("Checking if robot is already at pose. Target vs Current:");
        for (let key in pose) {
            const jointName = key as ValidJoints;
            const targetPos = pose[jointName];
            if (targetPos !== undefined) {
                try {
                    const currentPos = this.getJointValue(jointName);
                    if (currentPos === undefined || isNaN(currentPos)) {
                        console.log(`isAlreadyAtPose: Joint ${jointName} has invalid current position:`, currentPos);
                        return false;
                    }
                    const diff = Math.abs(targetPos - currentPos);
                    console.log(`- ${jointName}: Target=${targetPos.toFixed(4)}, Current=${currentPos.toFixed(4)}, Diff=${diff.toFixed(4)} (Tol=${tolerance})`);
                    if (diff > tolerance) {
                        console.log(`isAlreadyAtPose: Joint ${jointName} exceeds tolerance.`);
                        return false;
                    }
                } catch (e) {
                    console.log(`isAlreadyAtPose: Exception querying joint ${jointName}:`, e);
                    return false;
                }
            }
        }
        console.log("isAlreadyAtPose: All joints within tolerance. Already at pose!");
        return true;
    }

    async executePoseGoal(pose: RobotPose) {
        await this.switchToNavigationMode();

        /// check if at goal already
        if (this.isAlreadyAtPose(pose)) {
            console.log("Robot is already at target pose, skipping execution.");
            this.playbackPosesResultCallback({
                state: MovementState.Executing,
                alert_type: "info",
            });
            setTimeout(() => {
                this.playbackPosesResultCallback({
                    state: MovementState.Success,
                    alert_type: "info",
                });
            }, 1000);
            return;
        }
        console.log("executing pose goal");

        this.stopExecution();
        this.poseGoal = this.makePoseGoal(pose, 1.5);
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
                let error_code = -4; // default fallback error code
                try {
                    error_code = JSON.parse(error.slice(error.indexOf("{"))).error_code;
                } catch (e) {
                    console.warn("Could not parse action error code:", e);
                }
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
                } else {
                    this.playbackPosesResultCallback({
                        state: MovementState.Fail,
                        alert_type: "error",
                    });
                }
            }
        );
    }

    async executePoseGoals(poses: RobotPose[], index: number) {
        await this.switchToNavigationMode();

        // check if at goal already
        if (poses.length > 0) {
            const finalPose = poses[poses.length - 1];
            if (this.isAlreadyAtPose(finalPose)) {
                console.log("Robot is already at final target pose, skipping execution.");
                this.playbackPosesResultCallback({
                    state: MovementState.Executing,
                    alert_type: "info",
                });
                setTimeout(() => {
                    this.playbackPosesResultCallback({
                        state: MovementState.Success,
                        alert_type: "info",
                    });
                }, 1000);
                return;
            }
        }

        this.stopExecution();
        this.poseGoal = this.makePoseGoals(poses, 1.5);
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
                } else {
                    this.playbackPosesResultCallback({
                        state: MovementState.Fail,
                        alert_type: "error",
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
                let error_code = -4; // default fallback error code
                try {
                    error_code = JSON.parse(error.slice(error.indexOf("{"))).error_code;
                } catch (e) {
                    console.warn("Could not parse action error code:", e);
                }
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
                } else {
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

        // Toggle base-only collision when publication starts (set to false to enforce full-body collision)
        this.toggleBaseOnlyCollision(false);

        this.moveBaseGoal = this.makeMoveBaseGoal(pose);

        // New status-watch session: ignore historical SUCCEEDED until we see
        // ACCEPTED/EXECUTING (or feedback) for this goal.
        this.moveBaseStatusWatching = true;
        this.moveBaseStatusSeenActive = false;
        this.moveBaseStatusLastEmitted = undefined;
        this.moveBaseTerminalBaseline = undefined;
        this.moveBaseGoalXY = {
            x: pose.position.x,
            y: pose.position.y,
        };
        this.moveBaseInsideTolStreak = 0;

        // Immediately notify operator that navigation has started executing
        this.moveBaseResultCallback({
            state: "Navigation executing!",
            alert_type: "info",
        });

        this.moveBaseGoalID = this.moveBaseClient.sendGoal(
            this.moveBaseGoal,
            (result) => {
                console.log("Navigation succeeded:", result);
                this.moveBaseResultCallback({
                    state: "Navigation succeeded!",
                    alert_type: "success",
                });
                this.toggleBaseOnlyCollision(true);
            },
            (feedback) => {
                // Feedback proves this goal is live even if status topic is laggy.
                this.moveBaseStatusSeenActive = true;
                console.log("Navigation feedback:", feedback);
            },
            (error) => {
                console.log("Navigation failed/canceled:", error);
                if (error && (error.includes("canceled") || error.includes("cancel"))) {
                    this.moveBaseResultCallback({
                        state: "Navigation canceled!",
                        alert_type: "error",
                    });
                } else {
                    this.moveBaseResultCallback({
                        state: "Navigation failed!",
                        alert_type: "error",
                    });
                }
                this.toggleBaseOnlyCollision(true);
            }
        );
    }

    async executeIncrementalMove(jointName: ValidJoints, increment: number) {
        await this.switchToNavigationMode();
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
                this.poseGoal = undefined;
                this.poseGoalID = undefined;
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
                console.log(
                    "Error for action on " +
                    this.trajectoryClient.name +
                    ": " +
                    error
                );
                this.poseGoal = undefined;
                this.poseGoalID = undefined;
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
        if (this.moveBaseGoalID) {
            this.moveBaseClient.cancelGoal(this.moveBaseGoalID);
            this.moveBaseGoalID = undefined;
            this.moveBaseGoal = undefined;
            // Operator CancelGoal already synthesizes local cancel UI; stop
            // watching so a later stale SUCCEEDED does not clear/start races.
            this.moveBaseStatusWatching = false;
            this.moveBaseStatusSeenActive = false;
            this.moveBaseTerminalBaseline = undefined;
            this.moveBaseGoalXY = undefined;
            this.moveBaseInsideTolStreak = 0;
        }
    }

    getJointValue(jointName: ValidJoints): number {
        if (
            jointName === "translate_mobile_base" ||
            jointName === "rotate_mobile_base"
        ) {
            return 0;
        }

        let name: string = jointName;
        if (name === "arm_joint" || name === "wrist_extension") {
            let total = 0;
            let foundAny = false;
            for (let link of ["arm_l1_joint", "arm_l2_joint", "arm_l3_joint", "arm_l4_joint"]) {
                let idx = this.jointState.name.indexOf(link as ValidJoints);
                if (idx !== -1) {
                    total += this.jointState.position[idx];
                    foundAny = true;
                }
            }
            if (foundAny) return total;

            // Fallback for when individual telescoping links are not published:
            // Check if either "arm_joint" or "wrist_extension" is available in the jointState.
            let idx = this.jointState.name.indexOf(name as ValidJoints);
            if (idx !== -1) {
                return this.jointState.position[idx];
            }
            let fallbackName = name === "arm_joint" ? "wrist_extension" : "arm_joint";
            let fallbackIdx = this.jointState.name.indexOf(fallbackName as ValidJoints);
            if (fallbackIdx !== -1) {
                return this.jointState.position[fallbackIdx];
            }
        }

        let jointIndex = this.jointState.name.indexOf(name as ValidJoints);
        return this.jointState.position[jointIndex];
    }


    inJointLimits(jointName: ValidJoints) {
        let jointValue = this.getJointValue(jointName);
        return this.inJointLimitsHelper(jointValue, jointName);
    }

    inJointLimitsHelper(jointValue: number, jointName: ValidJoints) {
        if (this.diagnosticJointLimits[jointName] !== undefined) {
            return this.diagnosticJointLimits[jointName];
        }

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

    async isCollisionMonitorActive(timeoutMs: number = 3000): Promise<boolean> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const isActive = await new Promise<boolean>((resolve) => {
                const rosAny = this.ros as any;
                if (rosAny.getNodes !== undefined) {
                    rosAny.getNodes(
                        (nodes: string[]) => {
                            resolve(nodes.some((node: string) => node.endsWith("collision_monitor")));
                        },
                        () => resolve(false)
                    );
                } else {
                    resolve(false);
                }
            });

            if (isActive) {
                return true;
            }

            // Wait 500ms before checking again
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        console.log("Timed out waiting for collision_monitor node. Defaulting to /cmd_vel.");
        return false;
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
