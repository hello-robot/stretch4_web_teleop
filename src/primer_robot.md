# Primer: Robot Peer

The **robot peer** is the Python process that runs onboard the Stretch robot and bridges ROS 2 to the operator's browser over WebRTC. It has no UI. When the interface is launched it waits for the cameras to come up, joins the signaling room, and waits for an operator.

It replaced the **robot page**: a headless Firefox (driven by Playwright) that reached ROS through `rosbridge` and re-encoded camera frames through a `<canvas>`. The operator page did not change. The robot peer speaks the same signaling, data-channel messages, and track labels the robot page did. `tools/latency/` measures the two side by side and checks that they behave the same.

> For a high-level view of how the robot peer and the operator browser fit together, see [`primer_software_architecture.md`](primer_software_architecture.md).

______________________________________________________________________

## Directory Layout

```
start_robot_peer.py             # entry point; web_interface.launch.py runs and respawns it
stretch4_web_teleop_robot/
├── main.py                     # rclpy executor thread + asyncio loop, signals, shutdown
├── session.py                  # port of the robot page's index.tsx: forwarding + command dispatch
├── robot.py                    # port of robot.tsx: every ROS 2 interaction
├── webrtc.py                   # robot end of WebRTCConnection (aiortc)
├── media.py                    # camera tracks (JPEG -> encoder) and the microphone
├── ros_util.py                 # QoS matching, message -> JSON, remote parameters
├── joint_velocities.py         # playback velocity table (mirrors src/shared/util.tsx)
├── features.py                 # features.json + FEATURE_* overrides
└── signaling/
    ├── local.py                # socket.io to server.js (the LAN door)
    ├── firebase.py             # Realtime Database REST + event stream (the cloud door)
    └── coordinator.py          # both doors at once, one operator at a time
```

Python dependencies are in the `robot` group of `pyproject.toml` (`pip install --group pyproject.toml:robot`), and `version_check` flags missing ones at launch.

______________________________________________________________________

## Threads

rclpy callbacks run on a `MultiThreadedExecutor` in a background thread. WebRTC, signaling, and all of the robot's state live on one asyncio loop in the main thread. `Robot` hands each ROS callback to the loop with `call_soon_threadsafe`, so its state needs no locks.

Camera frames are the exception. Each camera subscription has its own callback group, so its JPEG decode runs on an executor thread in parallel with everything else, and only the decoded frame is handed over.

______________________________________________________________________

## Startup (`session.py`, `Session.start`)

1. Waits until both camera topics have publishers. This means the driver and cameras are up, the same check the robot page made through rosbridge.
1. `Robot.on_connect()` creates every subscription, publisher, service client, action client and parameter client.
1. Subscribes to the two camera topics and opens the microphone.
1. Asks `/map_server/map` for the occupancy grid.
1. Configures signaling and joins the robot room, retrying every 500 ms until it gets in. In `firebase` mode this signs the robot account in through the Identity Toolkit REST API.

> _**NOTE:**_ The robot peer always runs locally onboard the robot; nothing robot-side is part of the Firebase Hosting `/r/<tag>/` rail builds. In `firebase` mode, the git tag checked out on the robot (`robots/<fleetId>/build`) determines which `/r/<tag>/operator/` bundle a cloud operator loads, so the operator and the robot peer speak the same data-channel message schema (see [`primer_rails.md`](primer_rails.md)).

## Session lifecycle (`handle_session_start`)

Called when an operator joins. It adds the overhead and gripper camera tracks and the microphone track, opens the `messages` data channel, and the robot makes the offer. Each track gets its own media stream id, and `cameraInfo` in the offer maps those ids to `overhead`, `gripper` and `audio`. That mapping is how the operator labels what it receives.

## Video path

```
/…/compressed (JPEG) → CameraSource.on_jpeg: decode once (PyAV, executor thread)
                     → CameraTrack (newest frame only) → aiortc VP8/H.264 encoder → WebRTC
```

Frames go out at the camera's own rate and resolution. Nothing is decoded while no operator is connected. The robot page decoded each JPEG into an `<img>`, drew it onto a canvas upscaled to at least 1000 px tall, and captured that canvas at 6 fps.

## Incoming messages (`Session.handle_message`)

| Message type | Robot method |
| :--- | :--- |
| `driveBase` | `execute_base_velocity(modifier)` |
| `setJointVelocity` | `set_joint_velocity(joint, velocity)` |
| `setTaskSpaceVelocity` | `set_task_space_velocity(x, y, z)` |
| `incrementalMove` | `execute_incremental_move(joint, increment)` |
| `stopTrajectory` / `stopMoveBase` | `stop_trajectory_client()` / `stop_move_base_client()` |
| `setRobotMode` | `switch_to_navigation_mode()` / `switch_to_position_mode()` |
| `setCameraPerspective` | `use_left_camera()` / `use_right_camera()` / `use_center_camera()` |
| `setRobotPose` / `playbackPoses` | `execute_pose_goal(pose)` / `execute_pose_goals(poses)` |
| `moveBase` | `execute_move_base_goal(pose)` |
| `setExpandedGripper` / `setRunStop` | `set_expanded_gripper(toggle)` / `set_run_stop(toggle)` |
| `getOccupancyGrid` / `getStretchTool` / `getMaxEeSpeed` / `getRunStop` | reply with the current value |
| `homeTheRobot` / `seedLocalization` / `shutdown` | `std_srvs/Trigger` services |
| `getVoiceCapability` / `requestVoiceToken` | voice control (see `ai-gateway/`) |

Velocity, pose and navigation commands each run as their own asyncio task, so a command that has to switch the driver's mode first does not hold up the rest.

## Outgoing messages

`Robot` reports through the `Forwarder` methods on `Session`, which send the same messages the robot page did: `validJointState`, `batteryState`, `odom`, `mode`, `isHomed`, `isRunStopped`, `leaseStatus`, `stretchTool`, `maxEeSpeed`, `moveBaseState`, `playbackPosesState`, `seedLocalizationState`, `amclPose` (throttled to 2 Hz), `navPlan`, `occupancyGrid` and `occupancyGridUnavailable`.

> **Occupancy grid chunking:** the `data` array is split into 50,000-cell slices, one `occupancyGrid` message each, and the operator concatenates them. If a slice would exceed the operator's SCTP message size limit, it is halved until it fits.

______________________________________________________________________

## `robot.py`: the `Robot` class

### ROS interfaces

- **Subscriptions**: `/joint_states`, `/joint_limits`, `/battery`, `/wheel_odom`, `/plan`, `/mode`, `/is_runstopped`, `/joint_states_diagnostics`, `/server_lease_holder`, `/navigate_to_pose/_action/status`, `/parameter_events`, and the two camera topics. QoS is matched to whoever publishes when the subscription is made, the same as rosbridge. If nobody publishes yet, it falls back to best-effort/volatile, which is compatible with any publisher that comes later.
- **Publishers**: `/teleop/cmd_vel` and `/teleop/joint_vel` when `ee_velocity_limiter` is on; otherwise `/cmd_vel` or `/cmd_vel_nav` (chosen by polling collision_monitor's lifecycle state) and `/joint_vel`. Also `/ee_cmd_vel`.
- **Actions**: `/follow_joint_trajectory`, `/navigate_to_pose`.
- **Services**: camera switching, `/expanded_gripper`, `/runstop_the_robot`, `/joystick_control`, `/home_the_robot`, `/seed_localization`, `/system/shutdown`, `/map_server/map` (`nav_msgs/srv/GetMap`), `/collision_monitor/get_state`.
- **Parameters** on other nodes: `stretch_driver` (`mode`, `tool_info.is_actuated`), `configure_video_streams_gripper` (`stretch_tool`), `ee_velocity_safety_filter` (`max_ee_speed`, also followed on `/parameter_events`).
- **TF**: once a map has loaded, `base_link` in the `map` frame at 10 Hz when it moves. This replaced `tf2_web_republisher`.

### Robot modes

Stretch runs in one of three modes, set through the `stretch_driver` `mode` parameter:

| Mode | Description |
| :--- | :--- |
| `position` | Default. Position commands to arm; position commands to base. |
| `navigation` | Needed for trajectory goals. Position commands to arm; velocity commands to base. |
| `velocity` | Velocity commands to both arm and base. Used for continuous jogging. |

`switch_to_*_mode()` skip the change when the robot is already in that mode or runstopped. Concurrent requests for the same mode share one parameter call. A velocity command is dropped, not sent, if the mode switch fails.

______________________________________________________________________

## How to Add a New Robot Capability (Summary)

1. **`src/shared/commands.tsx`**: define `interface MyCommand { type: "myCommand"; ... }` and add it to the `cmd` union.
1. **`src/shared/remoterobot.tsx`**: add `myAction() { this.robotChannel({ type: "myCommand" }); }`.
1. **`stretch4_web_teleop_robot/robot.py`**: implement the ROS 2 interaction. If data flows back to the operator, add a method to `Forwarder` and call it from the subscription handler (which runs on the asyncio loop).
1. **`stretch4_web_teleop_robot/session.py`**: add a branch to `handle_message()` for operator → robot commands, and implement the `Forwarder` method that sends the robot → operator message.
1. **Operator side**: update `operator/tsx/index.tsx` to handle the new message type and wire it to the appropriate function provider.
1. Add the command to `PARITY_COMMANDS` in `tools/latency/measure_latency.js` if its replies are worth guarding.
