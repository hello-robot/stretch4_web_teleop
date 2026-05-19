# Primer: Operator Page

The **operator page** is the browser-based UI through which a user teleoperates the Stretch 4 robot. It connects to the robot browser over WebRTC, receives sensor/camera data, and sends movement commands back.

> For a worked example of adding a brand-new feature end-to-end (the "Home the Robot" button), see [`documentation/development.md`](../../../../documentation/development.md).

______________________________________________________________________

## Directory Layout

```
src/pages/operator/
├── html/                        # Entry HTML page
├── css/                         # Page and component stylesheets
├── icons/                       # SVG icon assets
└── tsx/                         # All TypeScript/React source
    ├── index.tsx                # Module entry point — bootstraps WebRTC and renders root
    ├── MobileOperator.tsx       # Mobile operator root component
    ├── function_providers/      # Logic layer connecting UI to the robot
    ├── layout_components/       # Composite, stateful UI components
    ├── basic_components/        # Small, reusable UI primitives
    ├── static_components/       # Mostly-fixed UI panels (header, sidebar, etc.)
    ├── storage_handler/         # Layout persistence (local or Firebase)
    ├── utils/                   # Shared types, enums, and small utilities
    └── default_layouts/         # JSON default layout configs
```

______________________________________________________________________

## Shared Layer (`src/shared/`)

Before describing the operator page itself, it helps to understand the shared layer it builds on. These four files define the common language between the two browser peers.

### `commands.tsx`

This file defines the common language between the operator and robot browsers. It defines every **command** the interface can transmit — the full vocabulary of robot actions. For example, you can ask Nav2 to navigate the robot using the MoveBaseCommand, or you can ask the driver for the battery's current voltage using GetBatteryVoltageCommand. Every action taken in the web interface is converted into a command and transmitted through WebRTC's data channel to the robot browser, where it is interpreted and further transmitted to Stretch's ROS2 packages.

Each command is a TypeScript interface with a `type` discriminant:

```ts
export interface HomeTheRobotCommand {
    type: "homeTheRobot";
}
```

All commands are collected into the `cmd` union type, which is what WebRTC's data channel actually carries:

```ts
export type cmd = DriveCommand | IncrementalMove | HomeTheRobotCommand | ...;
```

**When adding a new capability**, define its command here first.

### `remoterobot.tsx`

This file wraps the logic for receiving and transmitting commands, sensor streams, etc. over the WebRTC channels in a nice API for the operator browser. You can think of `RemoteRobot` as the bridge between the operator browser and the robot. The interface creates a single instance of `RemoteRobot` and uses it for the duration of the session that it is connected to the robot. On the other end, the robot browser is listening for commands from / transmitting data to `RemoteRobot`. Each method packages a command and sends it through the WebRTC data channel:

```ts
homeTheRobot() {
    let cmd: HomeTheRobotCommand = { type: "homeTheRobot" };
    this.robotChannel(cmd);
}
```

**When adding a new capability**, add a method to `RemoteRobot` that dispatches the new command.

### `util.tsx`

This file contains shared custom message types, variables, and enums For example, this file defines the WebRTC message types:

```js
export type WebRTCMessage =
    ...
    | cmd;
```

`cmd` is imported from `commands.tsx`. This means all commands defined in `commands.tsx` can be transmitted over WebRTC. You do not need to edit this file for the homing functionality, you just need to define your command as described [in this section](#commandstsx).

You generally do not need to edit this file unless adding a new WebRTC message type.

### `webrtcconnections.tsx`

*Note: You should never touch this file!*

This file contains the code used for establishing a peer connection between the operator and robot browser and setting up data channels such that they can communicate.

______________________________________________________________________

## Entry Point: `tsx/index.tsx`

This file is the module entry. It:

1. **Creates** all `FunctionProvider` singletons (see below).
1. **Establishes** the WebRTC connection to the robot browser.
1. **Handles two WebRTC callbacks**:
   - `handleRemoteTrackAdded()` — subscribes to video/audio media channels so they feed the camera views.
   - `handleWebRTCMessage()` — a switch statement that routes incoming robot data to the right function provider or state variable:
     ```ts
     case "isRunStopped":
         remoteRobot.sensors.setRunStopState(message.enabled);
     case "moveBaseState":
         underMapFunctionProvider.setMoveBaseState(message.message);
     case "occupancyGrid":
         // chunked and assembled into occupancyGrid module-level var
     ```
1. **Calls** `initializeOperator()` once the data channel is open, which:
   - Creates the `RemoteRobot` instance and sets up its sensor callbacks.
   - Creates the `StorageHandler` (loads the saved layout).
   - Instantiates providers that require storage (e.g. `MovementRecorderFunctionProvider`, `UnderMapFunctionProvider`, etc.).
   - Renders `MobileOperator` (Note, we currently only have the mobile version of the operator page. On desktop, the mobile operator page is scaled up to fit the screen).

Key module-level exports that components import directly (no prop-drilling):
| Export | Type | Description |
| :--- | :--- | :--- |
| `buttonFunctionProvider` | `ButtonFunctionProvider` | Main movement logic |
| `runStopFunctionProvider` | `RunStopFunctionProvider` | Run-stop state |
| `batteryVoltageFunctionProvider` | `BatteryVoltageFunctionProvider` | Battery display |
| `movementRecorderFunctionProvider` | `MovementRecorderFunctionProvider` | Playback/recording |
| `underMapFunctionProvider` | `UnderMapFunctionProvider` | Autonomous navigation |
| `homeTheRobotFunctionProvider` | `HomeTheRobotFunctionProvider` | Homing sequence |
| `cameraSwitcherFunctionProvider` | `CameraSwitcherFunctionProvider` | Camera perspective |
| `occupancyGrid` | `ROSOccupancyGrid \| undefined` | Current map data |
| `stretchTool` | `StretchTool` | Currently mounted tool |
| `storageHandler` | `StorageHandler` | Persisted layout/recordings |

______________________________________________________________________

## Root Components

### `MobileOperator.tsx`

The active root component rendered on the user's device. Renders two the **Pilot Mode** scene by default (live camera + robot controls) and the **Auto Nav** scene can but accessed from the scene menu (map-based autonomous navigation).

______________________________________________________________________

## Function Providers (`tsx/function_providers/`)

The **function provider** pattern is the core architectural idea: React components are kept logic-free. Each component is given a function provider object at render time, and calls methods on it in response to user interactions. Components define an enum naming the actions they need, and the provider returns an anonymous function for each:

```ts
// In the component:
export enum HomeTheRobotFunction { Home }

// In the provider:
public provideFunctions(fn: HomeTheRobotFunction) {
    switch (fn) {
        case HomeTheRobotFunction.Home:
            return () => { FunctionProvider.remoteRobot?.homeTheRobot(); };
    }
}

// In the component's render:
const Home = homeTheRobotFunctionProvider.provideFunctions(HomeTheRobotFunction.Home);
<button onClick={Home}>Home</button>
```

### `FunctionProvider` (base class)

All providers extend this. It holds:

- `static remoteRobot` — the single shared `RemoteRobot` instance (set via `addRemoteRobot()`)
- `static velocityScale`, `actionMode`, `pilotControlsCurrent` — global control settings shared across all providers
- `setBaseVelocity()` / `incrementalJointMovement()` / `continuousJointMovement()` — shared motion helpers that manage the velocity heartbeat interval (sent every 25 ms)
- `stopCurrentAction()` — cancels any active velocity send loop or timeout

### `ButtonFunctionProvider`

The heaviest provider. Maps every `ButtonPadButton` enum value to robot actions. Handles:

- Different **action modes**: `StepActions` (tap once, move discrete amount), `PressRelease` (hold for continuous), `ClickClick` (tap to start, tap to stop)
- **Joint state callbacks** from the robot → updates which buttons are at their limits/in collision → updates `ButtonStateMap` for the UI
- Drive, arm, lift, wrist, gripper, head, and camera-perspective commands

### `MovementRecorderFunctionProvider`

Manages recording and playing back sequences of joint poses. Interfaces with `StorageHandler` to persist recordings. Streams playback state back via operator callback.

### `UnderMapFunctionProvider`

Handles autonomous move-base navigation. Sends navigation goals via `RemoteRobot`, receives action state feedback, and exposes an operator callback for alert rendering.

### `HomeTheRobotFunctionProvider`

Tracks homing and robot mode state. Exposes `updateModeState()` and `updateIsHomedState()` for the WebRTC message handler to call.

### `RunStopFunctionProvider`

Tracks the software run-stop state. Exposes `updateRunStopState()`.

### `BatteryVoltageFunctionProvider`

Tracks battery voltage. Exposes `updateVoltage()`.

### `MapFunctionProvider`

Handles click-on-map → navigation goal conversion.

### `CameraSwitcherFunctionProvider`

Manages which camera perspective is active.

______________________________________________________________________

## Component Folders

There are three component folders, each with a different intended scope:

- **`layout_components/`** — customizable components that form the interactive body of the interface (camera views, button pads, map, movement recorder). In the desktop `Operator`, these can be added, removed, or rearranged by toggling "Customize".
- **`static_components/`** — fixed components found in the header, footer, or sidebar (speed controls, action mode selector, run-stop, occupancy grid canvas, etc.). They cannot be moved by the user.
- **`basic_components/`** — generic, robot-agnostic UI primitives (dropdowns, modals, carousels, tab groups) used to build the above two.

### Notable Layout Components

| Component | Purpose |
| :--- | :--- |
| `PilotMode` | Top-level pilot scene: camera view + controls tab group + movement recorder + footer |
| `SimpleCameraView` | Renders a single camera video stream |
| `GripperCamPIP` | Gripper camera picture-in-picture overlay |
| `ButtonPad` | Grid of robot control buttons; receives functions from `ButtonFunctionProvider` |
| `MovementRecorder` | Feature for recording, naming, editing, and replaying pose sequences |
| `AutoNav` | Map view + click-to-navigate goal setting |
| `FooterPilotMode` | Bottom toolbar: camera switcher, action speed, action mode, scene navigation |
| `FooterAutoNav` | Bottom toolbar in auto-nav scene: goal input, move-base controls |
| `FooterGlobal` | Persistent bottom bar switching between pilot/auto-nav scenes |
| `HomeTheRobot` | Prominent banner shown when robot is un-homed, with a "Home" button |

### Notable Static Components

| Component | Purpose |
| :--- | :--- |
| `ActionMode` | Dropdown: Step Actions / Press-Release / Click-Click |
| `ActionSpeed` | Speed selector (Slowest → Fastest) |
| `PilotControlsToggle` | Switches between button pad layouts (Omni Drive, Arm, etc.) |
| `RunStop` | Software run-stop indicator/button |
| `OccupancyGrid` | Canvas-based 2D map renderer (CreateJS); robot marker, goal marker, saved pose markers |
| `CameraSwitcher` | Buttons to switch camera perspective |

### Notable Basic Components

| Component | Purpose |
| :--- | :--- |
| `SceneCarousel` | Horizontally scrollable scene switcher carousel |
| `PlaybackStatusbar` | Progress bar for movement playback |
| `Flex` | Lightweight flexbox layout wrapper |

______________________________________________________________________

## Storage Handler (`tsx/storage_handler/`)

Persists the operator's layout and recordings across sessions. Two backends:

- **`LocalStorageHandler`** — uses browser `localStorage`; default for on-robot use.
- **`FirebaseStorageHandler`** — syncs to Firestore; used when `process.env.storage === "firebase"`.

Both implement the common `StorageHandler` interface.

______________________________________________________________________

## Utils (`tsx/utils/`)

| File | Contents |
| :--- | :--- |
| `component_definitions.tsx` | Enums and types for the layout system: `ComponentType`, `CameraViewId`, `ActionModeType`, `LayoutDefinition`, `ComponentDefinition`, etc. |
| `genUUID.tsx` | Thin wrapper around the uuid library |
| `hex-to-rgb-array.tsx` | `#rrggbb` → `[r, g, b]` color conversion |
| `svg.tsx` | Inline SVG strings for all button pad icons (arm directions, gripper, head, etc.) |

______________________________________________________________________

## Full Data Flow

```
WebRTC media channels
        │
        ▼
  handleRemoteTrackAdded()      ← feeds camera <video> elements

WebRTC data channel (robot → operator)
        │
        ▼
  handleWebRTCMessage()         ← index.tsx switch statement
        │
  ┌─────┴──────────────────────────────────────────────┐
  │ joint states   → buttonFunctionProvider            │
  │ battery        → batteryVoltageFunctionProvider    │
  │ mode/homed     → homeTheRobotFunctionProvider      │
  │ run-stop       → runStopFunctionProvider           │
  │ occupancy grid → occupancyGrid (module-level var)  │
  │ move-base      → underMapFunctionProvider          │
  │ playback       → movementRecorderFunctionProvider  │
  └────────────────────────────────────────────────────┘
        │
        ▼
  React components re-render (via provider callbacks)
        │
  User interaction (button press, map click, etc.)
        │
        ▼
  FunctionProvider.provideFunctions(SomeEnum.Action)()
        │
        ▼
  RemoteRobot.someAction()   →   cmd object
        │
        ▼
  WebRTC data channel (operator → robot)
        │
        ▼
  robot/index.tsx handleMessage() switch
        │
        ▼
  Robot.executeX() → ROSLib → rosbridge → ROS2
```

______________________________________________________________________

## How to Add a New Feature (Summary)

1. **`shared/commands.tsx`** — define a new `interface MyCommand { type: "myCommand"; ... }` and add it to the `cmd` union.
1. **`shared/remoterobot.tsx`** — add a method `myAction() { this.robotChannel({ type: "myCommand" }); }`.
1. **`robot/tsx/index.tsx`** — add a `case "myCommand": robot.myAction(); break;` in `handleMessage()`.
1. **`robot/tsx/robot.tsx`** — implement `myAction()` using ROSLib (service, topic, or action client).
1. **`operator/tsx/function_providers/MyFunctionProvider.tsx`** — extend `FunctionProvider`, implement `provideFunctions()`.
1. **`operator/tsx/index.tsx`** — instantiate the new provider and wire up any WebRTC message callbacks.
1. **Component** — define the `enum MyFunction` and render a component that calls `myFunctionProvider.provideFunctions(...)`.

______________________________________________________________________

## Key Design Decisions

**Function providers are singletons, not React context.** Components import them directly from `index.tsx`. This avoids prop-drilling but means the providers are module-global — they exist for the lifetime of the page.

**Action modes are global, not per-component.** `FunctionProvider.actionMode` is a static field. All button pads share the same mode.

**The operator does not talk to ROS directly.** All ROS communication goes through the robot browser (`robot/tsx/robot.tsx` ↔ ROSLib ↔ rosbridge). The operator only speaks to the robot browser through `remoterobot.tsx` and WebRTC.
