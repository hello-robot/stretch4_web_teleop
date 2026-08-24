# Primer: Robot Page

The **robot page** is the headless browser that runs onboard the Stretch robot. It has no visible UI — its job is to bridge ROS2 (running on the robot) and the operator browser (running on a remote device) over WebRTC. When the interface is launched, this page starts first, connects to `rosbridge`, and waits for an operator to join.

> For a high-level view of how the robot and operator browsers fit together, see [`primer_software_architecture.md`](primer_software_architecture.md).

______________________________________________________________________

## Directory Layout

```
src/pages/robot/
├── html/                  # Entry HTML page (headless, no visible UI)
├── css/                   # Minimal stylesheet
└── tsx/
    ├── index.tsx          # Module entry point — bootstraps Robot, WebRTC, and media streams
    ├── robot.tsx          # Robot class — all ROS2 interaction lives here
    ├── videostreams.tsx   # VideoStream class — decodes compressed images and produces a MediaStream
    └── audiostreams.tsx   # AudioStream class — captures microphone audio for WebRTC
```

______________________________________________________________________

## Entry Point: `tsx/index.tsx`

This file is the module entry. It wires together the three main subsystems — `Robot`, `WebRTCConnection`, and media streams — and manages the lifecycle of a session.

### Startup Sequence

1. **Instantiates `Robot`** with a set of forwarding callbacks (one per ROS2 data stream). Each callback calls `connection.sendData()` to forward the data to the operator browser over WebRTC.
1. **Instantiates `WebRTCConnection`** as the robot peer.
1. **Instantiates media streams**: `navigationStream`, `gripperStream` (both `VideoStream`), and `audioStream` (`AudioStream`).
1. **Sets `onRosConnectCallback`** — once ROS is ready, this callback:
   - Subscribes to the camera topics and starts the video streams.
   - Fetches the occupancy grid map (if there is one).
   - Logs into the signaling server and joins the robot room, then waits for an operator.
1. **Calls `robot.connect()`** to initiate the rosbridge WebSocket connection.

### Session Lifecycle (`handleSessionStart`)

Called by `WebRTCConnection` when an operator joins. It:

1. Removes any existing media tracks from the peer connection.
1. Adds the head cameras and gripper cameras to the peer connection.
1. Opens the WebRTC data channels for bidirectional command/data flow.

### Incoming Message Handler (`handleMessage`)

A switch statement that routes every incoming `WebRTCMessage` from the operator browser to the appropriate `Robot` method:

| Message type | Robot method called |
| :--- | :--- |
| `driveBase` | `executeBaseVelocity(modifier)` |
| `setJointVelocity` | `setJointVelocity(jointName, velocity)` |
| `incrementalMove` | `executeIncrementalMove(jointName, increment)` |
| `stopTrajectory` | `stopTrajectoryClient()` |
| `stopMoveBase` | `stopMoveBaseClient()` |
| `setRobotMode` | `switchToNavigationMode()` / `switchToPositionMode()` |
| `setCameraPerspective` | `useLeftCamera()` / `useRightCamera()` / `useCenterCamera()` |
| `setRobotPose` | `executePoseGoal(pose)` |
| `playbackPoses` | `executePoseGoals(poses, 0)` |
| `moveBase` | `executeMoveBaseGoal(pose)` |
| `setExpandedGripper` | `setExpandedGripper(toggle)` |
| `setRunStop` | `setRunStop(toggle)` |
| `getOccupancyGrid` | `getOccupancyGrid()` |
| `getStretchTool` | `getStretchTool()` |
| `homeTheRobot` | `homeTheRobot()` |

### Forwarding Callbacks

Each of these functions is registered with `Robot` at startup. When the robot publishes new data, `Robot` calls the callback, which packages the data and sends it to the operator browser via `connection.sendData()`:

| Callback | WebRTC message type sent |
| :--- | :--- |
| `forwardJointStates` | `validJointState` (robotPose, limits, collision) |
| `forwardBatteryState` | `batteryVoltage` |
| `forwardOccupancyGrid` | `occupancyGrid` (chunked into 50k-element slices) |
| `forwardActionState` | `moveBaseState` or `playbackPosesState` |
| `forwardAMCLPose` | `amclPose` |
| `forwardMode` | `mode` |
| `forwardIsHomed` | `isHomed` |
| `forwardIsRunStopped` | `isRunStopped` |
| `forwardStretchTool` | `stretchTool` |

> **Note on occupancy grid chunking:** Map data can be very large. `forwardOccupancyGrid` splits the `data` array into 50,000-element slices and sends each as a separate `occupancyGrid` message. The operator browser reassembles them by concatenating the `data` arrays.

______________________________________________________________________

## `robot.tsx` — The `Robot` Class

`Robot` is the single source of truth for all ROS2 communication. It owns every ROSLib client (topics, services, action clients) and exposes a clean set of methods that `index.tsx` calls in response to operator commands.

### ROS Connection

```
robot.connect()
  └── new Ros({ url: "wss://localhost:9090" })
        ├── on "connection" → checkROSConnection() → onConnect()
        ├── on "error"      → reconnect()
        └── on "close"      → reconnect()
```

`checkROSConnection()` verifies that the two required camera topics have publishers before proceeding. This guards against timing issues where rosbridge connects before all required ROS nodes have started. If the check fails, it reconnects after 1 second.

`onConnect()` sets up all ROSLib clients:

- **Subscriptions**: joint states, joint limits, battery state, mode, is-homed, is-run-stopped, action results
- **Action clients**: `follow_joint_trajectory`, `navigate_to_pose`
- **Topics**: `/cmd_vel` (base velocity), `/joint_vel` (joint velocity)
- **Services**: camera switcher services, expanded gripper, run-stop, home the robot
- **Params**: `stretch_tool`, `mode` (read/write via rosbridge parameter API)

### Robot Modes

Stretch operates in one of three modes, controlled by writing to the `/stretch_driver:mode` ROS parameter:

| Mode | Description |
| :--- | :--- |
| `position` | Default. Position commands to arm; position commands to base. |
| `navigation` | Needed for trajectory goals. Position commands to arm; velocity commands to base. |
| `velocity` | Velocity commands to both arm and base. Used for continuous jogging. |

Methods `switchToNavigationMode()`, `switchToPositionMode()`, `switchToVelocityMode()` guard against redundant mode changes using the module-level `robotMode` variable.

### Movement Methods

| Method | ROS interface | Notes |
| :--- | :--- | :--- |
| `executeBaseVelocity(props)` | Publishes `Twist` to `/cmd_vel` | Switches to velocity mode first |
| `setJointVelocity(joint, vel)` | Publishes `JointJog` to `/joint_vel` | Switches to velocity mode first |
| `executeIncrementalMove(joint, inc)` | Sends goal to `/follow_joint_trajectory` | Adds `inc` to current joint value |
| `executePoseGoal(pose)` | Sends goal to `/follow_joint_trajectory` | Switches to navigation mode |
| `executePoseGoals(poses, idx)` | Sends multi-point goal to `/follow_joint_trajectory` | Used for movement playback |
| `executeMoveBaseGoal(pose)` | Sends goal to `/navigate_to_pose` | Nav2 autonomous navigation |
| `stopTrajectoryClient()` | Cancels active trajectory goal | Fires `Cancel` callback |
| `stopMoveBaseClient()` | Cancels active move-base goal | — |
| `homeTheRobot()` | Calls `/home_the_robot` service | `std_srvs/Trigger` |

Trajectory goals remap operator `stretch_gripper_joint` (finger rad) → driver `gripper_joint` (stretch_gripper pct). Pose playback / `executePoseGoal` run body joints then a gripper-only goal (driver gripper monitoring is pct-vs-world-rad and times out in mixed goals). Multi-pose recordings keep the full body path but only the **last** gripper aperture (mid-path open/close is not replayed). Velocity `/joint_vel` keeps `stretch_gripper_joint`.

## Full Data Flow (Robot Page)

```
ROS2 (rosbridge wss://localhost:9090)
        │
        ▼
  Robot subscriptions / service calls
        │
  ┌─────┴──────────────────────────────────────────────┐
  │ /joint_states     → forwardJointStates             │
  │ /battery          → forwardBatteryState            │
  │ /mode             → forwardMode                    │
  │ /is_homed         → forwardIsHomed                 │
  │ is_runstopped     → forwardIsRunStopped            │
  │ /navigate_to_pose → forwardActionState             │
  │ AMCL TF           → forwardAMCLPose               │
  │ map_server/map    → forwardOccupancyGrid (chunked) │
  └────────────────────────────────────────────────────┘
        │
        ▼
  connection.sendData()  →  WebRTC data channel  →  Operator browser

  Operator browser  →  WebRTC data channel  →  handleMessage()
        │
        ▼
  robot.executeX() / robot.setX() / robot.getX()
        │
        ▼
  ROSLib → rosbridge → ROS2 (topics, services, actions)
        │
        ▼
  Camera topics → VideoStream.updateImage() → MediaStream
        │
        ▼
  WebRTC media channel → Operator browser camera views
```

______________________________________________________________________

## How to Add a New Robot Capability (Summary)

1. **`shared/commands.tsx`** — define `interface MyCommand { type: "myCommand"; ... }` and add it to the `cmd` union.
1. **`shared/remoterobot.tsx`** — add `myAction() { this.robotChannel({ type: "myCommand" }); }`.
1. **`robot/tsx/robot.tsx`** — implement the ROS2 interaction (subscribe to a topic, call a service, send an action goal). If the robot needs to push data back, accept a callback in the constructor and call it from the subscription.
1. **`robot/tsx/index.tsx`**:
   - Add a forwarding callback that calls `connection.sendData()` if data flows robot → operator.
   - Add a `case "myCommand": robot.myAction(); break;` in `handleMessage()` for operator → robot commands.
   - Pass the forwarding callback into the `Robot` constructor.
1. **Operator side** — update `operator/tsx/index.tsx` to handle the new WebRTC message type and wire it to the appropriate function provider.
