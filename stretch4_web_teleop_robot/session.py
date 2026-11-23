"""Operator session: what the robot and the operator say to each other.

Forwards robot state to the operator over the data channel, dispatches the
operator's commands to the robot, and attaches the camera and microphone
tracks whenever an operator joins.
"""

import asyncio
import json
import logging
import math
import ssl
import time
from typing import Any, Callable

from .features import FEATURE_VOICE_CONTROL_INTERFACE, FEATURE_VOICE_INPUT_RECORDING
from .media import CameraSource, Microphone
from .robot import Robot
from .webrtc import RobotConnection, encode_message

log = logging.getLogger(__name__)

OCCUPANCY_GRID_CHUNK = 50000
AMCL_POSE_MIN_INTERVAL_S = 0.5
AMCL_POSE_HEARTBEAT_S = 1.0
AMCL_POSE_MIN_TRANSLATION_M = 0.02
AMCL_POSE_MIN_YAW_RAD = 0.03

NAVIGATION_TOPIC = "/navigation_camera/image_raw/rotated/compressed"
GRIPPER_TOPIC = "/gripper_camera/image_raw/cropped/compressed"


def yaw_from_quaternion(q: dict) -> float:
    siny_cosp = 2 * (q["w"] * q["z"] + q["x"] * q["y"])
    cosy_cosp = 1 - 2 * (q["y"] * q["y"] + q["z"] * q["z"])
    return math.atan2(siny_cosp, cosy_cosp)


class Session:
    def __init__(
        self,
        node,
        loop: asyncio.AbstractEventLoop,
        microphone_spec: str,
        server_url: str,
    ):
        self.loop = loop
        self.server_url = server_url
        self.robot = Robot(node, loop, self)
        self.navigation = CameraSource("navigation", loop)
        self.gripper = CameraSource("gripper", loop)
        self.microphone = Microphone(microphone_spec)
        self.connection: RobotConnection | None = None
        self._last_amcl_sent_at = 0.0
        self._last_amcl_sent: dict | None = None
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------- startup

    async def start(self, create_signaler) -> None:
        self.connection = RobotConnection(
            create_signaler,
            on_robot_connection_start=self.handle_session_start,
            on_message=self.handle_message,
        )
        log.info("Connecting to ROS...")
        await self.robot.wait_for_required_topics()
        self.robot.on_connect()
        self.robot.subscribe_to_camera(NAVIGATION_TOPIC, self.navigation.on_jpeg)
        self.robot.subscribe_to_camera(GRIPPER_TOPIC, self.gripper.on_jpeg)
        await self.loop.run_in_executor(None, self.microphone.start)
        self.robot.get_occupancy_grid()

        log.info("Waiting for configured signaler (i.e. logging in if using Firebase)")
        await self.connection.signaler.configure("")
        log.info("Signaler ready! Joining room.")
        while not await self.connection.signaler.join_as_robot():
            await asyncio.sleep(0.5)
        log.info("Joined robot room; waiting for an operator")

    async def stop(self) -> None:
        """Stop the robot, release the microphone, and leave the room.

        Each step runs even if an earlier one fails: stopping the robot matters
        most, and the capture thread must be gone before the event loop is.
        """
        steps: list[tuple[str, Callable[[], Any]]] = [
            ("stop robot execution", lambda: self.robot.stop_execution(True)),
            ("stop microphone", self.microphone.stop),
        ]
        if self.connection is not None:
            steps += [
                ("hang up", self.connection.hangup),
                ("close peer connection", self.connection.close),
                ("close signaling", self.connection.signaler.close),
            ]
        steps.append(("stop robot timers", self.robot.close))
        for name, step in steps:
            try:
                result = step()
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, 3.0)
            except Exception:  # noqa: BLE001 - shutting down regardless
                log.exception("Could not %s", name)

    # ------------------------------------------------------------- session

    def handle_session_start(self) -> None:
        """An operator joined: attach media and open the data channel."""
        connection = self.connection
        connection.remove_tracks()
        log.info("Adding local media streams to peer connection")
        connection.add_track(self.navigation.create_track(), "overhead")
        connection.add_track(self.gripper.create_track(), "gripper")
        audio = self.microphone.create_track()
        if audio is not None:
            connection.add_track(audio, "audio")
            log.info("Added robot audio track to peer connection")
        else:
            log.warning("No robot audio track to add")
        connection.open_data_channels()

    def send(self, message) -> None:
        if self.connection is not None:
            self.connection.send_data(message)

    def _spawn(self, coro) -> None:
        task = self.loop.create_task(coro)
        self._tasks.add(task)

        def done(t):
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                log.error("Command failed", exc_info=t.exception())

        task.add_done_callback(done)

    # ------------------------------------------------- robot -> operator

    def _forward_action_state(self, state: dict, kind: str) -> None:
        self.send({"type": kind, "message": state})

    def move_base_result(self, state: dict) -> None:
        self._forward_action_state(state, "moveBaseState")

    def playback_poses_result(self, state: dict) -> None:
        self._forward_action_state(state, "playbackPosesState")

    def mode(self, mode: str) -> None:
        self.send({"type": "mode", "value": mode})

    def is_homed(self, is_homed: bool) -> None:
        self.send({"type": "isHomed", "value": is_homed})

    def is_run_stopped(self, is_run_stopped: bool) -> None:
        self.send({"type": "isRunStopped", "enabled": is_run_stopped})

    def lease_status(self, holder: str, is_driver_holding: bool) -> None:
        self.send(
            {
                "type": "leaseStatus",
                "holder": holder,
                "isDriverHolding": is_driver_holding,
            }
        )

    def stretch_tool(self, name: str) -> None:
        self.send(
            {
                "type": "stretchTool",
                "value": name,
                "toolMetadata": {
                    "name": name or "unknown",
                    "isActuated": self.robot.is_tool_actuated(),
                },
            }
        )

    def max_ee_speed(self, speed: float) -> None:
        self.send({"type": "maxEeSpeed", "maxEeSpeed": speed})

    def joint_state(
        self, robot_pose: dict, joints_in_limits: dict, joints_in_collision: dict
    ) -> None:
        if self.connection is None or not self.connection.is_open():
            return
        self.send(
            {
                "type": "validJointState",
                "robotPose": robot_pose,
                "jointsInLimits": joints_in_limits,
                "jointsInCollision": joints_in_collision,
            }
        )

    def battery_state(self, msg) -> None:
        self.send(
            {
                "type": "batteryState",
                "percentage": msg.percentage,
                "isCharging": msg.power_supply_status == 1,
            }
        )

    def odom(self, odom: dict) -> None:
        if self.connection is not None and self.connection.is_open():
            self.send({"type": "odom", "message": odom})

    def occupancy_grid_unavailable(self) -> None:
        self.send({"type": "occupancyGridUnavailable"})

    def occupancy_grid(self, grid: dict) -> None:
        if self.connection is None or not self.connection.is_open():
            return
        data = grid["data"]
        limit = self.connection.max_message_size()
        chunk = OCCUPANCY_GRID_CHUNK
        i = 0
        while i < len(data):
            message = {
                "type": "occupancyGrid",
                "message": {
                    "header": grid["header"],
                    "info": grid["info"],
                    "data": data[i : i + chunk],
                },
            }
            if len(encode_message(message)) > limit and chunk > 1000:
                chunk //= 2  # keep each chunk under the peer's message size limit
                continue
            self.send(message)
            i += chunk

    def amcl_pose(self, transform: dict) -> None:
        now = time.monotonic()
        elapsed = now - self._last_amcl_sent_at
        if elapsed < AMCL_POSE_MIN_INTERVAL_S:
            return
        if (
            self._last_amcl_sent
            and not self._amcl_moved_enough(transform)
            and elapsed < AMCL_POSE_HEARTBEAT_S
        ):
            return
        self._last_amcl_sent_at = now
        self._last_amcl_sent = transform
        self.send({"type": "amclPose", "message": transform})

    def _amcl_moved_enough(self, transform: dict) -> bool:
        last = self._last_amcl_sent
        dx = transform["translation"]["x"] - last["translation"]["x"]
        dy = transform["translation"]["y"] - last["translation"]["y"]
        dyaw = abs(
            yaw_from_quaternion(transform["rotation"])
            - yaw_from_quaternion(last["rotation"])
        )
        if dyaw > math.pi:
            dyaw = 2 * math.pi - dyaw
        return (
            math.hypot(dx, dy) >= AMCL_POSE_MIN_TRANSLATION_M
            or dyaw >= AMCL_POSE_MIN_YAW_RAD
        )

    def nav_plan(self, points: list) -> None:
        self.send({"type": "navPlan", "points": points})

    # --------------------------------------------------------------- voice

    def forward_voice_capability(self) -> None:
        self.send(
            {
                "type": "voiceCapability",
                "enabled": FEATURE_VOICE_CONTROL_INTERFACE,
                "voiceInputRecording": FEATURE_VOICE_CONTROL_INTERFACE
                and FEATURE_VOICE_INPUT_RECORDING,
            }
        )

    async def forward_voice_token(self) -> None:
        """Mint an OpenAI Realtime credential from the local server for the operator.

        server.js accepts this loopback request without an operator session
        token (see ai-gateway/voice-session-auth.js isLocalRobotRequest).
        """

        def reply(**message):
            self.send({"type": "voiceToken", **message})

        if not FEATURE_VOICE_CONTROL_INTERFACE:
            reply(error="Voice control is not enabled on this robot")
            return
        import aiohttp

        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        try:
            async with aiohttp.ClientSession() as http:
                async with http.get(
                    f"{self.server_url}/openai-realtime/token", ssl=context
                ) as r:
                    body = await r.text()
                    if r.status != 200:
                        reply(error=f"Token endpoint HTTP {r.status}: {body[:200]}")
                        return
                    reply(credential=json.loads(body))
        except Exception as error:  # noqa: BLE001
            reply(error=str(error))

    # ------------------------------------------------- operator -> robot

    def handle_message(self, message) -> None:
        if not isinstance(message, dict) or "type" not in message:
            log.error("Malformed message: %.200s", message)
            return
        robot = self.robot
        kind = message["type"]
        if kind == "driveBase":
            self._spawn(robot.execute_base_velocity(message["modifier"]))
        elif kind == "setJointVelocity":
            self._spawn(
                robot.set_joint_velocity(
                    message["jointName"], float(message["velocity"])
                )
            )
        elif kind == "setTaskSpaceVelocity":
            self._spawn(
                robot.set_task_space_velocity(
                    float(message["linear_X"]),
                    float(message["linear_Y"]),
                    float(message["linear_Z"]),
                )
            )
        elif kind == "incrementalMove":
            self._spawn(
                robot.execute_incremental_move(
                    message["jointName"], float(message["increment"])
                )
            )
        elif kind == "stopTrajectory":
            robot.stop_trajectory_client()
        elif kind == "stopMoveBase":
            robot.stop_move_base_client()
        elif kind == "setRobotMode":
            if message.get("modifier") == "navigation":
                self._spawn(robot.switch_to_navigation_mode())
            else:
                self._spawn(robot.switch_to_position_mode())
        elif kind == "setCameraPerspective":
            perspective = message.get("perspective")
            if perspective == "left":
                robot.use_left_camera()
            elif perspective == "right":
                robot.use_right_camera()
            elif perspective == "center":
                robot.use_center_camera()
        elif kind == "setRobotPose":
            self._spawn(robot.execute_pose_goal(message["pose"]))
        elif kind == "playbackPoses":
            self._spawn(robot.execute_pose_goals(message["poses"]))
        elif kind == "moveBase":
            robot.execute_move_base_goal(message["pose"])
        elif kind == "setExpandedGripper":
            robot.set_expanded_gripper(bool(message["toggle"]))
        elif kind == "setRunStop":
            robot.set_run_stop(bool(message["toggle"]))
        elif kind == "getOccupancyGrid":
            robot.get_occupancy_grid()
        elif kind == "getStretchTool":
            self._spawn(robot.get_stretch_tool())
        elif kind == "getMaxEeSpeed":
            robot.get_max_ee_speed()
            # getMaxEeSpeed also reports the run-stop state; the operator
            # relies on receiving both.
            self.is_run_stopped(robot.get_is_run_stopped())
        elif kind == "getRunStop":
            self.is_run_stopped(robot.get_is_run_stopped())
        elif kind == "homeTheRobot":
            robot.home_the_robot()
        elif kind == "seedLocalization":
            robot.seed_localization(
                lambda success, text: self._forward_action_state(
                    {"state": text, "alert_type": "success" if success else "error"},
                    "seedLocalizationState",
                )
            )
        elif kind == "shutdown":
            robot.shutdown(
                lambda success, text: log.info(
                    "Shutdown initiated: %s %s", success, text
                )
            )
        elif kind == "getVoiceCapability":
            self.forward_voice_capability()
        elif kind == "requestVoiceToken":
            self._spawn(self.forward_voice_token())
