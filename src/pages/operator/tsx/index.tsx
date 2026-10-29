import { FirebaseOptions } from "firebase/app";
import "operator/css/index.css";
import React from "react";
import { createRoot, Root } from "react-dom/client";
import { cmd } from "shared/commands";
import {
    setOperatorVoiceInputRecording,
    setOperatorVoiceSvc,
} from "shared/operatorVoiceSession";
import { RemoteRobot } from "shared/remoterobot";
import {
    consumeOperatorTakeover,
    OPERATOR_SEAT_STALE_MS,
} from "shared/signaling/operatorSeat";
import {
    delay,
    JointVelocityLimitsMessage,
    parseToolMetadata,
    RemoteStream,
    ROSOccupancyGrid,
    ToolMetadata,
    updateJointVelocities,
    waitUntil,
    WebRTCMessage
} from "shared/util";
import { WebRTCConnection } from "shared/webrtcconnections";
import { waitUntilAsync } from "../../../shared/util";
import { LoginHandler } from "../../home/tsx/login_handler/LoginHandler";
import { createLoginHandler } from "../../home/tsx/utils";
import { BatteryVoltageFunctionProvider } from "./function_providers/BatteryVoltageFunctionProvider";
import { ButtonFunctionProvider } from "./function_providers/ButtonFunctionProvider";
import { CameraSwitcherFunctionProvider } from "./function_providers/CameraSwitcherFunctionProvider";
import { FlyingGripperFunctionProvider } from "./function_providers/FlyingGripperFunctionProvider";
import { FunctionProvider } from "./function_providers/FunctionProvider";
import { HomeTheRobotFunctionProvider } from "./function_providers/HomeTheRobotFunctionProvider";
import { MapFunctionProvider } from "./function_providers/MapFunctionProvider";
import { MovementRecorderFunctionProvider } from "./function_providers/MovementRecorderFunctionProvider";
import { RunStopFunctionProvider } from "./function_providers/RunStopFunctionProvider";
import { UnderMapFunctionProvider } from "./function_providers/UnderMapFunctionProvider";
import { MobileOperator } from "./MobileOperator";
import { notifyRemoteStreams } from "./remoteStreamStore";
import { RobotAudioPlayer } from "./utils/robotAudioPlayer";
import { FirebaseStorageHandler } from "./storage_handler/FirebaseStorageHandler";
import { LocalStorageHandler } from "./storage_handler/LocalStorageHandler";
import { StorageHandler } from "./storage_handler/StorageHandler";
import { DEFAULT_VELOCITY_SCALE } from "./utils/action-speed-scale";
import {
    configureVoiceTokenRelay,
    resolveVoiceToken,
} from "./voice/voiceTokenRelay";
import {
    advanceRecoveryWatchdog,
    canAttemptOperatorRecovery,
    shouldScheduleForegroundRecovery,
} from "shared/webrtcRecovery";

let allRemoteStreams: Map<string, RemoteStream> = new Map<
    string,
    RemoteStream
>();
let remoteRobot: RemoteRobot;
let connection: WebRTCConnection;
let root: Root;
let toolMetadata: ToolMetadata | undefined = undefined;
export let occupancyGrid: ROSOccupancyGrid | undefined = undefined;
export let storageHandler: StorageHandler;
export let loginHandler: LoginHandler;
let room_name: string | null = null;
let yieldedToOtherTab = false;

/** True when all WebRTC occupancy-grid chunks have been reassembled. */
export function isOccupancyGridComplete(
    grid: ROSOccupancyGrid | undefined,
): boolean {
    if (!grid?.info) return false;
    const expected = grid.info.width * grid.info.height;
    return expected > 0 && grid.data.length >= expected;
}

export function isOccupancyGridReady(): boolean {
    return isOccupancyGridComplete(occupancyGrid);
}

type OccupancyGridReadyListener = () => void;
const occupancyGridReadyListeners = new Set<OccupancyGridReadyListener>();

function notifyOccupancyGridReady() {
    occupancyGridReadyListeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            console.warn("occupancyGridReady listener failed:", err);
        }
    });
}

/** Subscribe to full map reassembly. Fires immediately if already ready. */
export function subscribeOccupancyGridReady(
    callback: OccupancyGridReadyListener,
): () => void {
    occupancyGridReadyListeners.add(callback);
    if (isOccupancyGridReady()) {
        callback();
    }
    return () => {
        occupancyGridReadyListeners.delete(callback);
    };
}

function resetOccupancyGrid() {
    occupancyGrid = undefined;
    occupancyGridReadyListeners.clear();
}

type ToolMetadataListener = (toolMetadata: ToolMetadata) => void;
const toolMetadataListeners = new Set<ToolMetadataListener>();

/** Subscribe to tool metadata updates. Fires immediately if already known. */
export function subscribeToolMetadata(
    callback: ToolMetadataListener,
): () => void {
    toolMetadataListeners.add(callback);
    if (toolMetadata) {
        callback(toolMetadata);
    }
    return () => {
        toolMetadataListeners.delete(callback);
    };
}

function setToolMetadata(newToolMetadata: ToolMetadata) {
    toolMetadata = newToolMetadata;
    toolMetadataListeners.forEach((listener) => listener(newToolMetadata));
}

// Create the function providers. These abstract the logic between the React
// components and remote robot.
export var buttonFunctionProvider = new ButtonFunctionProvider();
export var flyingGripperFunctionProvider = new FlyingGripperFunctionProvider();

export var runStopFunctionProvider = new RunStopFunctionProvider();
export var batteryVoltageFunctionProvider =
    new BatteryVoltageFunctionProvider();
export var mapFunctionProvider: MapFunctionProvider;
export var underMapFunctionProvider: UnderMapFunctionProvider;
export var movementRecorderFunctionProvider: MovementRecorderFunctionProvider;
export var homeTheRobotFunctionProvider: HomeTheRobotFunctionProvider =
    new HomeTheRobotFunctionProvider();
export var cameraSwitcherFunctionProvider = new CameraSwitcherFunctionProvider();

// Create the WebRTC connection and connect the operator room
connection = new WebRTCConnection({
    peerRole: "operator",
    polite: true,
    onMessage: handleWebRTCMessage,
    onTrackAdded: handleRemoteTrackAdded,
    onMessageChannelOpen: configureRemoteRobot,
    onOperatorDisplaced: () => {
        yieldedToOtherTab = true;
        showOperatorSeatNotice(
            "This account is already operating from another tab.",
        );
        connection.hangup();
    },
});

loginHandler = createLoginHandler(() => {
    console.log("Operator login handler ready");
});

new Promise<void>(async (resolve) => {
    let currURL = new URL(window.location.href);
    room_name = currURL.searchParams.get("robot");
    if (process.env.storage === "firebase" && !room_name) {
        room_name = process.env.HELLO_FLEET_ID;
    }
    if (
        process.env.storage === "firebase" &&
        !/^stretch-(re1|re2|se3|se4)-\d{4}$/.test(room_name)
    ) {
        console.error(`ERROR: Invalid room ${room_name}`);
        throw new Error("Invalid room name");
    }
    try {
        await connection.configure_signaler(room_name);
        console.log("Signaler ready!");
    } catch (error) {
        console.error("Failed to configure signaler.", error);
        return;
    }

    if (consumeOperatorTakeover()) connection.requestOperatorTakeover();

    let connected = false;
    let occupiedSince: number | undefined;
    let waitingOnSameAccount = false;
    while (!connected) {
        if (!waitingOnSameAccount) connection.hangup();

        // Attempt to join robot room
        let joinedRobotRoom = await connection.addOperatorToRobotRoom();
        if (!joinedRobotRoom) {
            const block = connection.operatorJoinBlock();
            if (block === "same-account") {
                if (!waitingOnSameAccount) {
                    console.log("Operator seat is in use in another tab");
                    showOperatorSeatNotice(
                        "Your account is teleoperating this robot from another browser tab.",
                    );
                }
                waitingOnSameAccount = true;
                await delay(2000);
                continue;
            }
            waitingOnSameAccount = false;
            console.log("Operator failed to join robot room");
            if (block === "other") {
                occupiedSince ??= Date.now();
                if (Date.now() - occupiedSince > OPERATOR_SEAT_STALE_MS) {
                    showOperatorSeatNotice(
                        "Another account is teleoperating this robot.",
                    );
                    return;
                }
            } else {
                occupiedSince = undefined;
            }
            await delay(500);
            continue;
        }
        waitingOnSameAccount = false;
        occupiedSince = undefined;

        // Wait for WebRTC connection to resolve, timeout after 10 seconds
        let isResolved = await waitUntil(
            () => connection.connectionState() == "connected",
            10000
        );
        if (!isResolved) {
            console.warn("WebRTC connection could not resolve");
            await delay(500);
            continue;
        }

        // Wait for data to flow through the data channel, timeout after 10 seconds
        connected = await waitUntilAsync(
            async () => await connection.isConnected(),
            10000
        );
        if (!connected) {
            console.warn("No data flowing through data channel");
            await delay(500);
            continue;
        }

        await delay(1000); // 1 second delay to allow data to flow through data channel
        initializeOperator();
        resolve();
    }
});

// Create root once when index is loaded
const container = document.getElementById("root");
root = createRoot(container!);

/** Handle when the WebRTC connection adds a new track on a camera video or audio stream. */
function handleRemoteTrackAdded(event: RTCTrackEvent) {
    const track = event.track;
    const stream = event.streams[0];
    let streamName = connection.cameraInfo[stream.id];
    console.log("Adding remote track", streamName);
    if (streamName != "audio") {
        console.log(stream.getVideoTracks()[0].getConstraints());
    }
    console.log("got track id=" + track.id, track);
    if (stream) {
        console.log("stream id=" + stream.id, stream);
    }
    console.log("OPERATOR: adding remote tracks");

    allRemoteStreams.set(streamName, { track: track, stream: stream });
    if (streamName === "overhead" || streamName === "gripper") {
        notifyRemoteStreams();
    }

    if (streamName === "audio" || track.kind === "audio") {
        console.log("OPERATOR: Routing robot audio stream to RobotAudioPlayer");
        RobotAudioPlayer.getInstance().playStream(stream);
    }
}

/**
 * Callback to handle a new WebRTC message from the robot browser.
 * @param message the {@link WebRTCMessage} or an array of messages.
 */
function handleWebRTCMessage(message: WebRTCMessage | WebRTCMessage[]) {
    if (message instanceof Array) {
        for (const subMessage of message) {
            // Recursive call to handle each message in the array
            handleWebRTCMessage(subMessage);
        }
        return;
    }

    switch (message.type) {
        case "validJointState":
            remoteRobot.sensors.checkValidJointState(
                message.robotPose,
                message.jointsInLimits,
                message.jointsInCollision
            );
            break;
        case "mode":
            remoteRobot.sensors.setMode(message.value);
            break;
        case "isHomed":
            remoteRobot.sensors.setIsHomed(message.value);
            break;
        case "isRunStopped":
            remoteRobot.sensors.setRunStopState(message.enabled);
            break;
        case "leaseStatus":
            remoteRobot.sensors.setLeaseStatus(message.holder, message.isDriverHolding);
            break;
        case "stretchTool":
            setToolMetadata(
                message.toolMetadata || parseToolMetadata(message.value),
            );
            console.log(
                "[Operator index] stretchTool message received:",
                message.value,
                "toolMetadata:",
                toolMetadata,
            );
            break;
        case "occupancyGrid":
            if (!occupancyGrid) {
                occupancyGrid = message.message;
            } else {
                occupancyGrid.data = occupancyGrid.data.concat(
                    message.message.data
                );
            }
            // Map has loaded successfully
            if (isOccupancyGridComplete(occupancyGrid)) {
                notifyOccupancyGridReady();
            }
            break;
        case "amclPose":
            remoteRobot.setMapPose(message.message);
            break;
        case "goalStatus":
            console.log("goalStatus", message.message);
            remoteRobot.setGoalReached(true);
            break;
        case "moveBaseState":
            console.log("moveBaseState", message.message);
            underMapFunctionProvider.setMoveBaseState(message.message);
            if (
                message.message.alert_type === "success" ||
                message.message.alert_type === "warning" ||
                message.message.alert_type === "error"
            ) {
                remoteRobot.setGoalReached(true);
            }
            break;
        case "playbackPosesState":
            console.log("playbackPosesState", message.message);
            movementRecorderFunctionProvider.setPlaybackPosesState(message.message);
            break;
        case "seedLocalizationState":
            console.log("seedLocalizationState", message.message);
            mapFunctionProvider.setSeedLocalizationState(message.message);
            break;
        case "relativePose":
            remoteRobot.setRelativePose(message.message);
            break;
        case "batteryVoltage":
            remoteRobot.sensors.setBatteryVoltage(message.message);
            break;
        case "odom":
            remoteRobot.sensors.setOdom(message.message);
            break;
        // @flag voice_control_interface
        case "voiceCapability":
            setOperatorVoiceSvc(message.enabled);
            setOperatorVoiceInputRecording(message.voiceInputRecording);
            break;
        // @flag voice_control_interface
        case "voiceToken":
            resolveVoiceToken(message);
            break;
        case "jointVelocityLimits":
            updateJointVelocities((message as JointVelocityLimitsMessage).jointVelocities);
            break;
        default:
            throw Error(`unhandled WebRTC message type ${message.type}`);
    }
}

/**
 * Sets up remote robot, creates the storage handler,
 * and renders the operator browser.
 */
function initializeOperator() {
    // configureRemoteRobot();
    const storageHandlerReadyCallback = () => {
        underMapFunctionProvider = new UnderMapFunctionProvider(storageHandler);
        movementRecorderFunctionProvider = new MovementRecorderFunctionProvider(
            storageHandler
        );
        renderOperator(storageHandler);
    };
    storageHandler = createStorageHandler(storageHandlerReadyCallback);
}

/**
 * Configures the remote robot, which connects with the robot browser over the
 * WebRTC connection.
 */
function configureRemoteRobot() {
    // Stop a held drive or joint before this channel is used.
    buttonFunctionProvider.disableActiveButton();
    flyingGripperFunctionProvider.disableActiveButton();
    remoteRobot = new RemoteRobot({
        robotChannel: (message: cmd) => connection.sendData(message),
    });
    resetOccupancyGrid();
    remoteRobot.getStretchTool("getStretchTool");
    // @flag voice_control_interface
    remoteRobot.getVoiceCapability();
    configureVoiceTokenRelay(() => remoteRobot.requestVoiceToken());
    remoteRobot.getJointVelocity("getJointVelocity");
    FunctionProvider.addRemoteRobot(remoteRobot);
    mapFunctionProvider = new MapFunctionProvider();
    remoteRobot.sensors.setFunctionProviderCallback(
        buttonFunctionProvider.updateJointStates
    );

    remoteRobot.sensors.setBatteryFunctionProviderCallback(
        batteryVoltageFunctionProvider.updateVoltage
    );
    remoteRobot.sensors.setModeFunctionProviderCallback(
        homeTheRobotFunctionProvider.updateModeState
    );
    remoteRobot.sensors.setIsHomedFunctionProviderCallback(
        homeTheRobotFunctionProvider.updateIsHomedState
    );
    remoteRobot.sensors.setRunStopFunctionProviderCallback(
        runStopFunctionProvider.updateRunStopState
    );
    remoteRobot.sensors.setLeaseStatusFunctionProviderCallback(
        (holder, isDriverHolding) => {
            if (!isDriverHolding) {
                buttonFunctionProvider.stopCurrentAction(true);
            }
        }
    );
}

/**
 * Creates a storage handler based on the `storage` property in the process
 * environment.
 * @param storageHandlerReadyCallback callback when the storage handler is ready
 * @returns the storage handler
 */
function createStorageHandler(storageHandlerReadyCallback: () => void) {
    switch (process.env.storage) {
        case "firebase":
            const config: FirebaseOptions = {
                apiKey: process.env.PUBLIC_FIREBASE_API_KEY,
                authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
                projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID,
                storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
                messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
                appId: process.env.PUBLIC_FIREBASE_APP_ID,
                measurementId: process.env.PUBLIC_FIREBASE_MEASUREMENT_ID,
            };
            return new FirebaseStorageHandler(
                storageHandlerReadyCallback,
                config
            );
        default:
            return new LocalStorageHandler(storageHandlerReadyCallback);
    }
}

function showOperatorSeatNotice(detail: string) {
    document.querySelectorAll("body > .boot-screen").forEach((node) => node.remove());
    const host = document.getElementById("root");
    if (!host) return;
    host.replaceChildren();

    const kicker = document.createElement("p");
    kicker.className = "op-seat-notice__kicker";
    kicker.textContent = "hello robot";

    const body = document.createElement("p");
    body.className = "op-seat-notice__detail";
    body.textContent = detail;

    const back = document.createElement("a");
    back.className = "op-seat-notice__button";
    back.href = "/";
    back.textContent = "←  Home";

    const card = document.createElement("div");
    card.className = "op-seat-notice__card";
    card.append(kicker, body, back);

    const notice = document.createElement("div");
    notice.className = "op-seat-notice";
    notice.append(card);
    host.append(notice);
}

/** Up-chevron used by the Dashboard control on the boot screen. */
function appendChevronUp(parent: HTMLElement) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 10.5 8 5.5 13 10.5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    parent.append(svg);
}

/**
 * Same layout as the first-paint screen in operator/html/index.html.
 * Styled by the inline stylesheet there.
 */
function createBootScreen(label: string): HTMLDivElement {
    const screen = document.createElement("div");
    screen.className = "boot-screen";

    const dashboard = document.createElement("a");
    dashboard.className = "boot-screen__dashboard";
    dashboard.href = "/";
    dashboard.setAttribute("aria-label", "Dashboard");
    dashboard.addEventListener("click", (event) => {
        event.preventDefault();
        window.history.back();
    });
    const icon = document.createElement("span");
    icon.className = "boot-screen__dashboard-icon";
    icon.setAttribute("aria-hidden", "true");
    appendChevronUp(icon);
    const dashboardLabel = document.createElement("span");
    dashboardLabel.className = "boot-screen__dashboard-label";
    dashboardLabel.textContent = "Dashboard";
    dashboard.append(icon, dashboardLabel);

    const spinner = document.createElement("div");
    spinner.className = "boot-screen__spinner";
    spinner.setAttribute("role", "status");
    const ring = document.createElement("div");
    ring.className = "boot-screen__spinner-ring";
    ring.setAttribute("aria-hidden", "true");
    const spinnerLabel = document.createElement("span");
    spinnerLabel.className = "boot-screen__spinner-label";
    spinnerLabel.textContent = label;
    spinner.append(ring, spinnerLabel);

    const reload = document.createElement("button");
    reload.className = "boot-screen__reload";
    reload.type = "button";
    reload.setAttribute("aria-label", "Reload");
    reload.textContent = "Reload";
    reload.addEventListener("click", () => {
        window.location.reload();
    });

    screen.append(dashboard, spinner, reload);
    return screen;
}

/**
 * Periodic check of the WebRTC connection state.
 * Shows the "Reconnecting" boot screen when the link drops, and rebuilds
 * the link after a few visible seconds down or when the page comes back.
 */
function initConnectionStateCheck() {
    const screen = createBootScreen("Reconnecting");
    // Visible seconds the link has been down.
    let downTicks = 0;
    // The page went to the background.
    let sawHidden = false;
    // Shared timer for visibilitychange and pageshow.
    let foregroundTimer: number | undefined;

    // Rebuild the link. Yield the seat when another tab holds it.
    const recoverConnection = async () => {
        if (
            !canAttemptOperatorRecovery({
                yielded: yieldedToOtherTab,
                hidden: document.hidden,
            })
        ) {
            return;
        }
        const recovered = await connection.recover();
        if (recovered || yieldedToOtherTab) return;
        const block = connection.operatorJoinBlock();
        if (!block) return;
        yieldedToOtherTab = true;
        showOperatorSeatNotice(
            block === "same-account"
                ? "Your account is teleoperating this robot from another browser tab."
                : "Another account is teleoperating this robot.",
        );
    };

    // 2 second wait. Another foreground event restarts this timer.
    const scheduleForegroundRecovery = () => {
        if (foregroundTimer !== undefined) {
            window.clearTimeout(foregroundTimer);
        }
        foregroundTimer = window.setTimeout(() => {
            foregroundTimer = undefined;
            void recoverConnection();
        }, 2000);
    };

    // Record a hide. Schedule a rebuild when the page is visible again.
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            sawHidden = true;
            return;
        }
        if (
            shouldScheduleForegroundRecovery({
                persisted: false,
                sawHidden,
            })
        ) {
            sawHidden = false;
            scheduleForegroundRecovery();
        }
    });
    // Back-forward cache restore.
    window.addEventListener("pageshow", (event) => {
        if (
            shouldScheduleForegroundRecovery({
                persisted: event.persisted,
                sawHidden,
            })
        ) {
            sawHidden = false;
            scheduleForegroundRecovery();
        }
    });

    // Update the reconnecting screen once a second.
    setInterval(async () => {
        if (yieldedToOtherTab) {
            screen.remove();
            return;
        }
        const connected = await connection.isConnected();
        const watchdog = advanceRecoveryWatchdog({
            linkUp: connected,
            visible: document.visibilityState === "visible",
            downTicks,
        });
        downTicks = watchdog.downTicks;
        if (connected) {
            if (document.body.contains(screen)) screen.remove();
            return;
        }
        if (!document.body.contains(screen)) document.body.appendChild(screen);
        if (watchdog.recover) void recoverConnection();
    }, 1000);
}

/**
 * Renders the operator browser.
 *
 * @param storageHandler the storage handler
 */
function renderOperator(storageHandler: StorageHandler) {
    const layout = storageHandler.loadCurrentLayoutOrDefault();
    FunctionProvider.initialize(
        DEFAULT_VELOCITY_SCALE,
        layout.actionMode,
        layout.pilotControlsCurrent
    );

    // The Mobile teleoperation UI
    root.render(
        <MobileOperator
            remoteStreams={allRemoteStreams}
            layout={layout}
            storageHandler={storageHandler}
        />
    )

    // Periodic check of the WebRTC connection state
    initConnectionStateCheck();
}

window.onbeforeunload = () => {
    RobotAudioPlayer.getInstance().stop();
    connection.hangup();
    connection.stop();
};

window.onunload = () => {
    RobotAudioPlayer.getInstance().stop();
    connection.hangup();
    connection.stop();
};
