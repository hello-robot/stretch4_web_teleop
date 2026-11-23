"""ROS 2 side of the robot peer: every topic, service, action and parameter.

Threading: rclpy callbacks run on executor threads and are handed to the
asyncio loop with ``call_soon_threadsafe``. All state below is only touched on
the loop, so no locks are needed. Camera frames are the exception: they are
decoded on their executor thread (see media.CameraSource) and never touch this
state.
"""

import asyncio
import logging
import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from action_msgs.msg import GoalStatus, GoalStatusArray
from action_msgs.srv import CancelGoal
from control_msgs.action import FollowJointTrajectory
from control_msgs.msg import JointJog
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus
from geometry_msgs.msg import Twist
from lifecycle_msgs.srv import GetState
from nav_msgs.msg import Odometry, Path
from nav_msgs.srv import GetMap
from rcl_interfaces.msg import ParameterEvent
from rclpy.action import ActionClient
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import QoSProfile
from rclpy.time import Time
from rosidl_runtime_py.set_message import set_message_fields
from sensor_msgs.msg import BatteryState, CompressedImage, JointState
from std_msgs.msg import Bool, String
from std_srvs.srv import SetBool, Trigger
from trajectory_msgs.msg import JointTrajectoryPoint

from . import joint_velocities as jv
from .features import FEATURE_EE_VELOCITY_LIMITER
from .ros_util import (
    RemoteParameters,
    ServiceUnavailable,
    call_service,
    subscription_qos,
    to_dict,
    wait_for_ready,
    wrap_future,
)

try:
    from nav2_msgs.action import NavigateToPose
except ImportError:  # Nav2 is optional; move-base commands are ignored without it
    NavigateToPose = None

log = logging.getLogger(__name__)

OCCUPANCY_GRID_MAX_RETRIES = 10
OCCUPANCY_GRID_RETRY_S = 2.0
MOVE_BASE_ACTION = "/navigate_to_pose"
FOLLOW_JOINT_TRAJECTORY_ACTION = "/follow_joint_trajectory"
NAV_PLAN_TOPIC = "/plan"
NAV_PLAN_MIN_SPACING_M = 0.05
NAV_PLAN_MAX_POINTS = 400
EE_VELOCITY_LIMITER_NODE = "ee_velocity_safety_filter"
JOINT_VELOCITY_HEARTBEAT_S = 0.05
REQUIRED_TOPICS = [
    "/gripper_camera/image_raw/cropped/compressed",
    "/navigation_camera/image_raw/rotated/compressed",
]
LIFECYCLE_ACTIVE = 3
MAP_TF_RATE_HZ = 10.0
MAP_TF_TRANS_THRESHOLD = 0.001
MAP_TF_ANGULAR_THRESHOLD = 0.001

NAVIGATION_EXECUTING = "Navigation executing!"
NAVIGATION_CANCELED = "Navigation canceled!"
NAVIGATION_SUCCEEDED = "Navigation succeeded!"
NAVIGATION_FAILED = "Navigation failed!"


class MovementState:
    EXECUTING = "movement executing!"
    SUCCESS = "movement successful!"
    CANCEL = "movement canceled!"
    FAIL = "movement failed!"


TERMINAL_STATUSES = (
    GoalStatus.STATUS_SUCCEEDED,
    GoalStatus.STATUS_CANCELED,
    GoalStatus.STATUS_ABORTED,
)
GRIPPER_NAMES = ("gripper_joint", "stretch_gripper_joint", "gripper_aperture")
ARM_LINKS = ("arm_l1_joint", "arm_l2_joint", "arm_l3_joint", "arm_l4_joint")
_POS_RE = re.compile(r"""['"]pos['"]\s*:\s*(True|1)""", re.IGNORECASE)
_NEG_RE = re.compile(r"""['"]neg['"]\s*:\s*(True|1)""", re.IGNORECASE)


def action_state(state: str, alert_type: str) -> dict:
    return {"state": state, "alert_type": alert_type}


class Forwarder(Protocol):
    """What the robot reports to the operator session (see session.py)."""

    def joint_state(
        self, robot_pose: dict, joints_in_limits: dict, joints_in_collision: dict
    ) -> None:
        ...

    def battery_state(self, msg: BatteryState) -> None:
        ...

    def occupancy_grid(self, grid: dict) -> None:
        ...

    def occupancy_grid_unavailable(self) -> None:
        ...

    def odom(self, odom: dict) -> None:
        ...

    def move_base_result(self, state: dict) -> None:
        ...

    def playback_poses_result(self, state: dict) -> None:
        ...

    def amcl_pose(self, transform: dict) -> None:
        ...

    def nav_plan(self, points: list) -> None:
        ...

    def mode(self, mode: str) -> None:
        ...

    def is_homed(self, is_homed: bool) -> None:
        ...

    def is_run_stopped(self, is_run_stopped: bool) -> None:
        ...

    def stretch_tool(self, name: str) -> None:
        ...

    def lease_status(self, holder: str, is_driver_holding: bool) -> None:
        ...

    def max_ee_speed(self, speed: float) -> None:
        ...


def thin_nav_plan(path: Path) -> list:
    """nav_msgs/Path as flat [x0, y0, x1, y1, ...], thinned and rounded to cm."""
    kept: list[tuple[float, float]] = []
    poses = path.poses
    for i, stamped in enumerate(poses):
        p = stamped.pose.position
        last = kept[-1] if kept else None
        if (
            last is None
            or i == len(poses) - 1
            or math.hypot(p.x - last[0], p.y - last[1]) >= NAV_PLAN_MIN_SPACING_M
        ):
            kept.append((p.x, p.y))
    stride = math.ceil(len(kept) / NAV_PLAN_MAX_POINTS) or 1
    points = []
    for i, (x, y) in enumerate(kept):
        if i % stride == 0 or i == len(kept) - 1:
            points.extend([round(x * 100) / 100, round(y * 100) / 100])
    return points


@dataclass
class _GoalToken:
    """Identity of one sent goal, standing in for rosbridge's goal id string."""

    cancel_requested: bool = False
    handle: Any = None


class Robot:
    def __init__(self, node: Node, loop: asyncio.AbstractEventLoop, forward: Forwarder):
        self.node = node
        self.loop = loop
        self.forward = forward
        self.robot_mode = "position"
        self.joint_limits: dict[str, tuple[float, float]] = {}
        self.diagnostic_joint_limits: dict[str, tuple[bool, bool]] = {}
        self.diagnostic_in_collision: dict[str, tuple[bool, bool]] = {}
        self.joint_state: JointState | None = None
        self.is_run_stopped: bool | None = None

        self.pose_goal = None
        self.pose_goal_id: _GoalToken | None = None
        self.pose_goal_watchdog: asyncio.TimerHandle | None = None

        self.move_base_goal = None
        self.move_base_goal_id: _GoalToken | None = None
        self.move_base_status_watching = False
        self.move_base_status_seen_active = False
        self.move_base_status_last_emitted: int | None = None
        self.move_base_terminal_baseline: int | None = None
        self.nav_plan_active = False

        self.collision_monitor_active = False
        self.occupancy_grid_request_id = 0
        self.occupancy_grid_retries = 0
        self.occupancy_grid_timer: asyncio.TimerHandle | None = None

        self.stretch_tool_name = "unknown"
        self.tool_is_actuated = True
        self.stretch_params_ready: asyncio.Future | None = None
        self._mode_switches: dict[str, asyncio.Task] = {}
        self._tasks: set[asyncio.Task] = set()
        self._timers: list = []
        self._tf_buffer: Any = None
        self._tf_listener: Any = None
        self._last_map_tf: tuple | None = None

    # ------------------------------------------------------------ plumbing

    def _spawn(self, coro) -> asyncio.Task:
        task = self.loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("Robot task failed", exc_info=task.exception())

    def _on_loop(self, handler: Callable) -> Callable:
        """Wrap a handler so an executor-thread callback runs it on the loop."""
        return lambda msg: self.loop.call_soon_threadsafe(handler, msg)

    def _subscribe(self, msg_type, topic: str, handler: Callable, depth: int = 10):
        return self.node.create_subscription(
            msg_type,
            topic,
            self._on_loop(handler),
            subscription_qos(self.node, topic, depth),
        )

    def _fire_service(
        self,
        client,
        request,
        on_result=None,
        on_error=None,
        wait: float = 0.0,
        timeout: float = 10.0,
    ):
        """Call a service without blocking the caller, like roslibjs callService."""

        async def run():
            try:
                response = await call_service(client, request, self.loop, timeout, wait)
            except (ServiceUnavailable, asyncio.TimeoutError) as error:
                log.info("Service %s failed: %s", client.srv_name, type(error).__name__)
                if on_error:
                    on_error(error)
                return
            if on_result:
                on_result(response)

        return self._spawn(run())

    # ------------------------------------------------------------- startup

    async def wait_for_required_topics(self, timeout_log_s: float = 5.0) -> None:
        """Block until the camera topics have publishers (the driver is up)."""
        waited = 0.0
        while True:
            missing = [t for t in REQUIRED_TOPICS if self.node.count_publishers(t) == 0]
            if not missing:
                log.info("All required topics found.")
                return
            if waited % timeout_log_s == 0:
                log.info(
                    "Required ROS nodes are not yet loaded; waiting for %s",
                    ", ".join(missing),
                )
            await asyncio.sleep(1.0)
            waited += 1.0

    def on_connect(self) -> None:
        node = self.node
        self._subscribe(JointState, "/joint_states", self._on_joint_state)
        self._subscribe(JointState, "/joint_limits", self._on_joint_limits)
        self._subscribe(BatteryState, "/battery", self.forward.battery_state)
        self._subscribe(
            Odometry, "/wheel_odom", lambda msg: self.forward.odom(to_dict(msg))
        )
        self._subscribe(Path, NAV_PLAN_TOPIC, self._on_nav_plan)
        self._subscribe(String, "/mode", self._on_mode)
        self._subscribe(Bool, "/is_runstopped", self._on_is_run_stopped)
        self._subscribe(
            DiagnosticArray,
            "/joint_states_diagnostics",
            self._on_joint_state_diagnostics,
        )
        self._subscribe(DiagnosticStatus, "/server_lease_holder", self._on_lease_holder)

        self.trajectory_client = ActionClient(
            node, FollowJointTrajectory, FOLLOW_JOINT_TRAJECTORY_ACTION
        )
        self.move_base_client = (
            ActionClient(node, NavigateToPose, MOVE_BASE_ACTION)
            if NavigateToPose is not None
            else None
        )
        self.move_base_cancel_all = node.create_client(
            CancelGoal, f"{MOVE_BASE_ACTION}/_action/cancel_goal"
        )
        # Nav2's status topic is the durable completion signal for the Stop UI.
        self._subscribe(
            GoalStatusArray,
            f"{MOVE_BASE_ACTION}/_action/status",
            self._on_move_base_status,
        )

        publisher_qos = QoSProfile(depth=10)
        if FEATURE_EE_VELOCITY_LIMITER:
            self.cmd_vel_nav = None
            self.cmd_vel_direct = node.create_publisher(
                Twist, "/teleop/cmd_vel", publisher_qos
            )
        else:
            self.cmd_vel_nav = node.create_publisher(
                Twist, "/cmd_vel_nav", publisher_qos
            )
            self.cmd_vel_direct = node.create_publisher(
                Twist, "/cmd_vel", publisher_qos
            )
        self.collision_monitor_state = node.create_client(
            GetState, "/collision_monitor/get_state"
        )
        self.joint_vel = node.create_publisher(
            JointJog,
            "/teleop/joint_vel" if FEATURE_EE_VELOCITY_LIMITER else "/joint_vel",
            publisher_qos,
        )
        self.ee_cmd_vel = node.create_publisher(Twist, "/ee_cmd_vel", publisher_qos)

        self.use_center_camera_srv = node.create_client(Trigger, "/use_center_camera")
        self.use_left_camera_srv = node.create_client(Trigger, "/use_left_camera")
        self.use_right_camera_srv = node.create_client(Trigger, "/use_right_camera")
        self.expanded_gripper_srv = node.create_client(SetBool, "/expanded_gripper")
        self.run_stop_srv = node.create_client(SetBool, "/runstop_the_robot")
        self.base_only_collision_srv = node.create_client(SetBool, "/joystick_control")
        self.home_srv = node.create_client(Trigger, "/home_the_robot")
        self.seed_localization_srv = node.create_client(Trigger, "/seed_localization")
        self.shutdown_srv = node.create_client(Trigger, "/system/shutdown")
        self.get_map_srv = node.create_client(GetMap, "/map_server/map")

        self.driver_params = RemoteParameters(node, "stretch_driver", self.loop)
        self.gripper_stream_params = RemoteParameters(
            node, "configure_video_streams_gripper", self.loop
        )
        self.limiter_params = RemoteParameters(
            node, EE_VELOCITY_LIMITER_NODE, self.loop
        )

        self._start_collision_monitor_poll()
        # Wait briefly for the service on startup, as rosbridge queued the call.
        self.toggle_base_only_collision(True, wait=5.0)
        self.init_stretch_params()

    def subscribe_to_camera(self, topic: str, on_jpeg: Callable[[bytes], None]) -> None:
        """Camera frames bypass the loop: decode on a dedicated executor thread."""

        def callback(msg: CompressedImage) -> None:
            on_jpeg(msg.data)

        self.node.create_subscription(
            CompressedImage,
            topic,
            callback,
            subscription_qos(self.node, topic, depth=1),
            callback_group=MutuallyExclusiveCallbackGroup(),
        )

    def close(self) -> None:
        for timer in self._timers:
            timer.cancel()
        for task in list(self._tasks):
            task.cancel()

    # -------------------------------------------------------- subscriptions

    def _on_joint_state(self, msg: JointState) -> None:
        self.joint_state = msg
        robot_pose = {name: pos for name, pos in zip(msg.name, msg.position)}
        arm = self.get_joint_value("arm_joint")
        if arm is not None:
            robot_pose["arm_joint"] = arm
        joints_in_limits = {}
        joints_in_collision = {}
        for name in dict.fromkeys([*msg.name, "arm_joint", "wrist_extension"]):
            in_limits = self.in_joint_limits(name)
            if in_limits:
                joints_in_limits[name] = list(in_limits)
            # Always truthy, as in robot.tsx: [false, false] when unknown.
            joints_in_collision[name] = list(self.in_collision(name))
        self.forward.joint_state(robot_pose, joints_in_limits, joints_in_collision)

    def _on_joint_limits(self, msg: JointState) -> None:
        for name, lower, upper in zip(msg.name, msg.position, msg.velocity):
            log.info("Got joint limit for %s %s %s", name, lower, upper)
            self.joint_limits[name] = (lower, upper)

    def _on_nav_plan(self, msg: Path) -> None:
        if self.nav_plan_active:
            self.forward.nav_plan(thin_nav_plan(msg))

    def _on_mode(self, msg: String) -> None:
        self.robot_mode = msg.data
        self.forward.mode(msg.data)

    def _on_is_run_stopped(self, msg: Bool) -> None:
        is_run_stopped = bool(msg.data)
        self.is_run_stopped = is_run_stopped
        if is_run_stopped:
            self.stop_execution(True)
            self.toggle_base_only_collision(True)
        self.forward.is_run_stopped(is_run_stopped)

    def get_is_run_stopped(self) -> bool:
        return bool(self.is_run_stopped)

    def _on_lease_holder(self, status: DiagnosticStatus) -> None:
        holder = "none"
        expired = False
        for pair in status.values:
            if pair.key == "lease_holder":
                holder = pair.value
            elif pair.key == "lease_expired":
                expired = pair.value.lower() == "true"
        self.forward.lease_status(holder, holder == "ros2_driver" or expired)

    @staticmethod
    def _diagnostic_joint(raw_key: str) -> str:
        return "gripper_joint" if raw_key in GRIPPER_NAMES else raw_key

    def _on_joint_state_diagnostics(self, msg: DiagnosticArray) -> None:
        for status in msg.status:
            if status.name == "is_homed":
                self.forward.is_homed(all(v.value == "True" for v in status.values))
            elif status.name in ("at_limit", "in_collision"):
                table = (
                    self.diagnostic_joint_limits
                    if status.name == "at_limit"
                    else self.diagnostic_in_collision
                )
                for v in status.values:
                    joint = self._diagnostic_joint(v.key)
                    is_pos = bool(_POS_RE.search(v.value))
                    is_neg = bool(_NEG_RE.search(v.value))
                    value = (
                        (not is_neg, not is_pos)
                        if status.name == "at_limit"
                        else (is_neg, is_pos)
                    )
                    if table.get(joint) != value:
                        log.info(
                            "[Diagnostics] %s for %s (%s): %s raw=%r",
                            status.name,
                            v.key,
                            joint,
                            value,
                            v.value,
                        )
                    table[joint] = value
                    # The driver says arm_joint where the UI may say wrist_extension.
                    if joint == "arm_joint":
                        table["wrist_extension"] = value
                    elif joint == "wrist_extension":
                        table["arm_joint"] = value

    # ---------------------------------------------------------- parameters

    def init_stretch_params(self) -> None:
        async def tool_name():
            value = await self.gripper_stream_params.get("stretch_tool")
            self.stretch_tool_name = value or "unknown"

        async def tool_actuated():
            value = await self.driver_params.get("tool_info.is_actuated")
            self.tool_is_actuated = True if value is None else bool(value)

        async def ready():
            # Never let a missing parameter hang getStretchTool.
            try:
                await asyncio.wait_for(
                    asyncio.gather(tool_name(), tool_actuated()), 3.0
                )
            except asyncio.TimeoutError:
                pass

        # tool_info.urdf_range only matters to the operator's jog increments,
        # which the operator scales itself; the robot side does not need it.
        self.stretch_params_ready = self._spawn(ready())
        self.init_max_ee_speed()

    def init_max_ee_speed(self) -> None:
        async def initial():
            self._apply_max_ee_speed(await self.limiter_params.get("max_ee_speed"))

        self._spawn(initial())
        self.node.create_subscription(
            ParameterEvent,
            "/parameter_events",
            self._on_loop(self._on_parameter_event),
            subscription_qos(self.node, "/parameter_events", 100),
        )

    def _on_parameter_event(self, event: ParameterEvent) -> None:
        if not event.node.endswith(f"/{EE_VELOCITY_LIMITER_NODE}"):
            return
        for parameter in [*event.new_parameters, *event.changed_parameters]:
            if parameter.name == "max_ee_speed":
                self._apply_max_ee_speed(parameter.value.double_value)
                return

    def _apply_max_ee_speed(self, speed) -> None:
        if isinstance(speed, bool) or not isinstance(speed, (int, float)):
            return
        if jv.set_max_ee_speed(speed):
            self.get_max_ee_speed()

    def get_max_ee_speed(self) -> None:
        self.forward.max_ee_speed(jv.get_max_ee_speed())

    def is_tool_actuated(self) -> bool:
        return self.tool_is_actuated

    async def get_stretch_tool(self) -> None:
        if self.stretch_params_ready is not None:
            await asyncio.shield(self.stretch_params_ready)
        self.forward.stretch_tool(self.stretch_tool_name)

    # ------------------------------------------------------------------ map

    def get_occupancy_grid(self) -> None:
        self._stop_occupancy_grid_poll()
        self.occupancy_grid_retries = 0
        self.occupancy_grid_request_id += 1
        self._request_occupancy_grid(self.occupancy_grid_request_id)

    def _request_occupancy_grid(self, request_id: int) -> None:
        def on_result(response):
            if request_id != self.occupancy_grid_request_id:
                return
            grid = response.map
            if grid.info.width * grid.info.height <= 0:
                self._report_occupancy_grid_unavailable(request_id)
                return
            self._stop_occupancy_grid_poll()
            self.subscribe_to_map_tf()
            self.forward.occupancy_grid(
                {
                    "header": to_dict(grid.header),
                    "info": to_dict(grid.info),
                    "data": grid.data.tolist()
                    if hasattr(grid.data, "tolist")
                    else list(grid.data),
                }
            )

        def on_error(_error):
            if request_id == self.occupancy_grid_request_id:
                self._report_occupancy_grid_unavailable(request_id)

        self._fire_service(
            self.get_map_srv,
            GetMap.Request(),
            on_result,
            on_error,
            wait=1.0,
            timeout=10.0,
        )

    def _report_occupancy_grid_unavailable(self, request_id: int) -> None:
        self._stop_occupancy_grid_poll()
        self.forward.occupancy_grid_unavailable()
        if self.occupancy_grid_retries >= OCCUPANCY_GRID_MAX_RETRIES:
            return
        self.occupancy_grid_retries += 1

        def retry():
            self.occupancy_grid_timer = None
            if request_id == self.occupancy_grid_request_id:
                self._request_occupancy_grid(request_id)

        self.occupancy_grid_timer = self.loop.call_later(OCCUPANCY_GRID_RETRY_S, retry)

    def _stop_occupancy_grid_poll(self) -> None:
        if self.occupancy_grid_timer is not None:
            self.occupancy_grid_timer.cancel()
            self.occupancy_grid_timer = None

    def subscribe_to_map_tf(self) -> None:
        """Report base_link in the map frame at 10 Hz when it moves.

        Replaces roslibjs' ROS2TFClient and tf2_web_republisher.
        """
        if self._tf_listener is not None:
            return
        import tf2_ros

        self._tf_buffer = tf2_ros.Buffer()
        self._tf_listener = tf2_ros.TransformListener(self._tf_buffer, self.node)
        self.node.create_timer(1.0 / MAP_TF_RATE_HZ, self._poll_map_tf)

    def _poll_map_tf(self) -> None:
        try:
            stamped = self._tf_buffer.lookup_transform("map", "base_link", Time())
        except Exception:  # noqa: BLE001 - not localized yet
            return
        t, r = stamped.transform.translation, stamped.transform.rotation
        current = (t.x, t.y, t.z, r.x, r.y, r.z, r.w)
        last = self._last_map_tf
        if last is not None:
            moved = math.dist(current[:3], last[:3]) > MAP_TF_TRANS_THRESHOLD
            dot = abs(sum(a * b for a, b in zip(current[3:], last[3:])))
            turned = 2 * math.acos(min(1.0, dot)) > MAP_TF_ANGULAR_THRESHOLD
            if not moved and not turned:
                return
        self._last_map_tf = current
        transform = {
            "translation": {"x": t.x, "y": t.y, "z": t.z},
            "rotation": {"x": r.x, "y": r.y, "z": r.z, "w": r.w},
        }
        self.loop.call_soon_threadsafe(self.forward.amcl_pose, transform)

    # ------------------------------------------------------- action status

    def _emit_move_base_result(self, state: dict) -> None:
        if state["state"] == NAVIGATION_EXECUTING:
            self.nav_plan_active = True
        else:
            self.move_base_goal_id = None
            self.move_base_goal = None
            self.move_base_status_watching = False
            self.move_base_status_seen_active = False
            self.move_base_terminal_baseline = None
            if self.nav_plan_active:
                self.nav_plan_active = False
                self.forward.nav_plan([])
        self.forward.move_base_result(state)

    def _handle_move_base_result(self, state: dict) -> None:
        if state["state"] == NAVIGATION_EXECUTING:
            self.toggle_base_only_collision(False)
        elif state["state"] in (
            NAVIGATION_SUCCEEDED,
            NAVIGATION_CANCELED,
            NAVIGATION_FAILED,
        ):
            log.info(
                "Navigation finished with state: %s. Restoring base-only collision.",
                state["state"],
            )
            self.toggle_base_only_collision(True)
        self._emit_move_base_result(state)

    def _on_move_base_status(self, msg: GoalStatusArray) -> None:
        """Read Nav2's status list without mistaking old SUCCEEDED entries for ours."""
        statuses = [s.status for s in msg.status_list]
        if not statuses:
            return
        terminal_count = sum(1 for s in statuses if s in TERMINAL_STATUSES)
        if self.move_base_terminal_baseline is None:
            self.move_base_terminal_baseline = terminal_count
        active = any(
            s
            in (
                GoalStatus.STATUS_ACCEPTED,
                GoalStatus.STATUS_EXECUTING,
                GoalStatus.STATUS_CANCELING,
            )
            for s in statuses
        )
        executing = GoalStatus.STATUS_EXECUTING in statuses

        if not self.move_base_status_watching:
            if active:
                log.info(
                    "Nav2 action server has an active goal on (re)load; watching it"
                )
                self.move_base_status_watching = True
                self.move_base_status_seen_active = True
                self.toggle_base_only_collision(False)
                self._handle_move_base_result(
                    action_state(NAVIGATION_EXECUTING, "info")
                )
                self.move_base_status_last_emitted = GoalStatus.STATUS_EXECUTING
            return

        if active:
            self.move_base_status_seen_active = True
            if (
                executing
                and self.move_base_status_last_emitted != GoalStatus.STATUS_EXECUTING
            ):
                self._handle_move_base_result(
                    action_state(NAVIGATION_EXECUTING, "info")
                )
                self.move_base_status_last_emitted = GoalStatus.STATUS_EXECUTING
            return

        if not self.move_base_status_seen_active and terminal_count > (
            self.move_base_terminal_baseline or 0
        ):
            self.move_base_status_seen_active = True
        if not self.move_base_status_seen_active:
            return

        terminal = next((s for s in reversed(statuses) if s in TERMINAL_STATUSES), None)
        if terminal is None or terminal == self.move_base_status_last_emitted:
            return
        log.info("For action %s got status %s", MOVE_BASE_ACTION, terminal)
        if terminal == GoalStatus.STATUS_SUCCEEDED:
            self._handle_move_base_result(action_state(NAVIGATION_SUCCEEDED, "success"))
        elif terminal == GoalStatus.STATUS_CANCELED:
            self._handle_move_base_result(action_state(NAVIGATION_CANCELED, "error"))
        else:
            self._handle_move_base_result(action_state(NAVIGATION_FAILED, "error"))
        self.toggle_base_only_collision(True)
        self.move_base_status_last_emitted = terminal

    # ------------------------------------------------------------- services

    def _start_collision_monitor_poll(self, interval_s: float = 2.0) -> None:
        """collision_monitor only forwards /cmd_vel_nav once ACTIVE; poll its lifecycle."""

        def poll():
            self._query_collision_monitor_active()
            self._timers.append(self.loop.call_later(interval_s, poll))

        poll()

    def _query_collision_monitor_active(self) -> None:
        if not self.collision_monitor_state.service_is_ready():
            self._set_collision_monitor_active(False)
            return
        self._fire_service(
            self.collision_monitor_state,
            GetState.Request(),
            lambda r: self._set_collision_monitor_active(
                r.current_state.id == LIFECYCLE_ACTIVE
            ),
            lambda _e: self._set_collision_monitor_active(False),
            timeout=1.5,
        )

    def _set_collision_monitor_active(self, active: bool) -> None:
        if active == self.collision_monitor_active:
            return
        self.collision_monitor_active = active
        log.info(
            "collision_monitor ACTIVE: Drive -> /cmd_vel_nav"
            if active
            else "collision_monitor not active: Drive -> /cmd_vel (no obstacle stopping)"
        )

    @property
    def cmd_vel(self):
        if FEATURE_EE_VELOCITY_LIMITER:
            return self.cmd_vel_direct
        return (
            self.cmd_vel_nav if self.collision_monitor_active else self.cmd_vel_direct
        )

    def use_left_camera(self):
        self._fire_service(
            self.use_left_camera_srv,
            Trigger.Request(),
            lambda _r: log.info("Switched to left camera"),
        )

    def use_right_camera(self):
        self._fire_service(
            self.use_right_camera_srv,
            Trigger.Request(),
            lambda _r: log.info("Switched to right camera"),
        )

    def use_center_camera(self):
        self._fire_service(
            self.use_center_camera_srv,
            Trigger.Request(),
            lambda _r: log.info("Switched to center camera"),
        )

    def set_expanded_gripper(self, toggle: bool) -> None:
        self._fire_service(
            self.expanded_gripper_srv,
            SetBool.Request(data=bool(toggle)),
            lambda r: log.info("Set expanded gripper to %s: %s", toggle, r.success),
        )

    def set_run_stop(self, toggle: bool) -> None:
        """Engage (True) or release the software runstop; engaging stops all motion."""
        if toggle:
            self.stop_execution(True)
            self.toggle_base_only_collision(True)
        log.info("Calling /runstop_the_robot with data=%s", toggle)
        self._fire_service(
            self.run_stop_srv,
            SetBool.Request(data=bool(toggle)),
            lambda r: log.info("setRunStop response: %s %s", r.success, r.message),
            lambda e: log.error("setRunStop service call failed: %s", e),
            wait=1.0,
        )

    def toggle_base_only_collision(self, value: bool, wait: float = 0.0) -> None:
        self._fire_service(
            self.base_only_collision_srv,
            SetBool.Request(data=bool(value)),
            lambda r: log.debug(
                "Toggled base-only collision to %s: %s", value, r.success
            ),
            wait=wait,
        )

    def home_the_robot(self) -> None:
        self._fire_service(
            self.home_srv,
            Trigger.Request(),
            lambda _r: log.info("Homing complete"),
            wait=1.0,
            timeout=120.0,
        )

    def seed_localization(self, on_result: Callable[[bool, str], None]) -> None:
        self._fire_service(
            self.seed_localization_srv,
            Trigger.Request(),
            lambda r: on_result(r.success, r.message),
            lambda e: on_result(
                False, f"Seed localization unavailable ({type(e).__name__})"
            ),
            wait=1.0,
            timeout=30.0,
        )

    def shutdown(self, on_result: Callable[[bool, str], None]) -> None:
        self._fire_service(
            self.shutdown_srv,
            Trigger.Request(),
            lambda r: on_result(r.success, r.message),
            wait=1.0,
        )

    # ---------------------------------------------------------------- modes

    def _run_stopped(self) -> bool:
        return bool(self.is_run_stopped) or self.robot_mode == "runstopped"

    async def _switch_mode(self, target: str) -> bool:
        """Put the driver in ``target`` mode. False if it could not be done."""
        if self._run_stopped():
            log.warning("Cannot switch mode while robot is runstopped")
            return False
        if self.robot_mode == target:
            return True
        task = self._mode_switches.get(target)
        if task is None:

            async def switch():
                try:
                    if await self.driver_params.set("mode", target):
                        self.robot_mode = target
                        log.info("Switched to %s mode", target)
                        return True
                    return False
                finally:
                    self._mode_switches.pop(target, None)

            task = self._spawn(switch())
            self._mode_switches[target] = task
        return await asyncio.shield(task)

    def switch_to_navigation_mode(self):
        return self._switch_mode("navigation")

    def switch_to_position_mode(self):
        return self._switch_mode("position")

    def switch_to_velocity_mode(self):
        return self._switch_mode("velocity")

    # ---------------------------------------------------------- velocities

    @staticmethod
    def _twist(lx=0.0, ly=0.0, lz=0.0, az=0.0) -> Twist:
        msg = Twist()
        msg.linear.x, msg.linear.y, msg.linear.z = float(lx), float(ly), float(lz)
        msg.angular.z = float(az)
        return msg

    async def execute_base_velocity(self, modifier: dict) -> None:
        lx, ly, az = (
            float(modifier.get(k, 0)) for k in ("linVelX", "linVelY", "angVel")
        )
        if lx == 0 and ly == 0 and az == 0:
            if self.cmd_vel is not None:
                self.cmd_vel.publish(self._twist())
            return
        if self._run_stopped():
            log.warning("Ignoring executeBaseVelocity while robot is runstopped")
            return
        if not await self.switch_to_velocity_mode() or self._run_stopped():
            return
        self.stop_execution()
        self.cmd_vel.publish(self._twist(lx, ly, 0.0, az))

    async def set_task_space_velocity(self, x: float, y: float, z: float) -> None:
        if x == 0 and y == 0 and z == 0:
            self.ee_cmd_vel.publish(self._twist())
            return
        if self._run_stopped():
            log.warning("Ignoring setTaskSpaceVelocity while robot is runstopped")
            return
        if not await self.switch_to_velocity_mode() or self._run_stopped():
            return
        self.stop_execution()
        self.ee_cmd_vel.publish(self._twist(x, y, z))

    def _jog(self, joint: str, velocity: float) -> JointJog:
        msg = JointJog()
        msg.joint_names = [joint]
        msg.velocities = [float(velocity)]
        msg.duration = JOINT_VELOCITY_HEARTBEAT_S
        return msg

    async def set_joint_velocity(self, joint: str, velocity: float) -> None:
        if velocity == 0:
            self.joint_vel.publish(self._jog(joint, 0.0))
            return
        if self._run_stopped():
            log.warning("Ignoring setJointVelocity while robot is runstopped")
            return
        if not await self.switch_to_velocity_mode() or self._run_stopped():
            return
        self.stop_execution()
        self.joint_vel.publish(self._jog(joint, velocity))

    # ---------------------------------------------------------------- joints

    def get_joint_value(self, joint: str):
        """Current position of ``joint``, or None if the driver does not report it."""
        if joint in ("translate_mobile_base", "rotate_mobile_base"):
            return 0.0
        state = self.joint_state
        if state is None:
            return None
        names = list(state.name)
        if joint in ("arm_joint", "wrist_extension"):
            found = [
                state.position[names.index(link)] for link in ARM_LINKS if link in names
            ]
            if found:
                return sum(found)
            for name in (
                joint,
                "wrist_extension" if joint == "arm_joint" else "arm_joint",
            ):
                if name in names:
                    return state.position[names.index(name)]
        if joint == "gripper_joint":
            for name in GRIPPER_NAMES:
                if name in names:
                    return state.position[names.index(name)]
        if joint in names:
            return state.position[names.index(joint)]
        return None

    @staticmethod
    def _alias(joint: str):
        return {"arm_joint": "wrist_extension", "wrist_extension": "arm_joint"}.get(
            joint
        )

    def in_joint_limits(self, joint: str):
        if joint in self.diagnostic_joint_limits:
            return self.diagnostic_joint_limits[joint]
        alias = self._alias(joint)
        if alias and alias in self.diagnostic_joint_limits:
            return self.diagnostic_joint_limits[alias]
        # /joint_limits is only published by the simulated driver.
        limits = self.joint_limits.get(joint)
        value = self.get_joint_value(joint)
        if not limits or value is None:
            return None
        return (value >= limits[0], value <= limits[1])

    def in_collision(self, joint: str):
        if joint in self.diagnostic_in_collision:
            return self.diagnostic_in_collision[joint]
        alias = self._alias(joint)
        if alias and alias in self.diagnostic_in_collision:
            return self.diagnostic_in_collision[alias]
        return (False, False)

    def is_already_at_pose(self, pose: dict, tolerance: float = 0.01) -> bool:
        if self.joint_state is None:
            return False
        for joint, target in pose.items():
            if target is None:
                continue
            current = self.get_joint_value(joint)
            if (
                current is None
                or math.isnan(current)
                or abs(target - current) > tolerance
            ):
                return False
        return True

    def _target_joint_name(self, joint: str) -> str:
        if joint == "gripper_joint" and self.joint_state is not None:
            names = list(self.joint_state.name)
            for alias in ("stretch_gripper_joint", "gripper_aperture"):
                if alias in names:
                    return alias
        return joint

    @staticmethod
    def _duration(seconds: float):
        secs = math.floor(seconds)
        nsecs = round((seconds - secs) * 1e9)
        if nsecs >= 1e9:
            secs, nsecs = secs + 1, 0
        return Duration(seconds=secs, nanoseconds=nsecs).to_msg()

    def make_pose_goal(self, pose: dict, min_duration: float = 0.5):
        if not pose:
            raise ValueError("Pose object cannot be empty")
        max_duration = min_duration
        names, positions = [], []
        for joint, target in pose.items():
            current = self.get_joint_value(joint)
            if current is not None and not math.isnan(current):
                velocity = jv.playback_joint_velocity(joint)
                if velocity > 0:
                    max_duration = max(max_duration, abs(target - current) / velocity)
            names.append(self._target_joint_name(joint))
            positions.append(float(target))
        goal = FollowJointTrajectory.Goal()
        goal.trajectory.joint_names = names
        goal.trajectory.points = [
            JointTrajectoryPoint(
                positions=positions,
                velocities=jv.playback_joint_velocities(names),
                time_from_start=self._duration(max_duration),
            )
        ]
        return goal

    def make_pose_goals(self, poses: list, min_segment_duration: float = 0.5):
        if not poses:
            raise ValueError("Poses array cannot be empty")
        names = list(poses[0].keys())
        points = []
        cumulative = 0.0
        previous: list[float] | None = None
        for pose in poses:
            segment = min_segment_duration
            positions = []
            for i, joint in enumerate(names):
                reference = (
                    self.get_joint_value(joint) if previous is None else previous[i]
                )
                target = pose.get(joint, reference)
                if target is None:
                    raise ValueError(f"No position for {joint}")
                positions.append(float(target))
                if reference is not None and not math.isnan(reference):
                    velocity = jv.playback_joint_velocity(joint)
                    if velocity > 0:
                        segment = max(segment, abs(target - reference) / velocity)
            cumulative += segment
            points.append(
                JointTrajectoryPoint(
                    positions=positions,
                    velocities=jv.playback_joint_velocities(names),
                    time_from_start=self._duration(cumulative),
                )
            )
            previous = positions
        goal = FollowJointTrajectory.Goal()
        goal.trajectory.joint_names = names
        goal.trajectory.points = points
        return goal, cumulative

    # ------------------------------------------------------------ trajectories

    async def _run_goal(
        self, client: ActionClient, goal, token: _GoalToken, feedback=None
    ):
        """Send a goal; return (status, result). Status None if never accepted."""
        if not client.server_is_ready() and not await wait_for_ready(
            client.server_is_ready, 1.0
        ):
            log.warning("Action server %s is not available", client._action_name)
            return None, None
        handle = await wrap_future(
            client.send_goal_async(goal, feedback_callback=feedback), self.loop
        )
        if not handle.accepted:
            log.warning("Goal rejected by %s", client._action_name)
            return None, None
        token.handle = handle
        if token.cancel_requested:
            handle.cancel_goal_async()
        response = await wrap_future(handle.get_result_async(), self.loop)
        return response.status, response.result

    @staticmethod
    def _cancel(token: _GoalToken | None) -> None:
        if token is None:
            return
        token.cancel_requested = True
        if token.handle is not None:
            token.handle.cancel_goal_async()

    def _cancel_pose_playback(self) -> None:
        self.forward.playback_poses_result(action_state(MovementState.CANCEL, "error"))

    def _skip_pose(self) -> None:
        log.info("Robot is already at target pose, skipping execution.")
        self.forward.playback_poses_result(
            action_state(MovementState.EXECUTING, "info")
        )
        self.loop.call_later(
            1.0,
            lambda: self.forward.playback_poses_result(
                action_state(MovementState.SUCCESS, "info")
            ),
        )

    async def execute_pose_goal(self, pose: dict) -> None:
        if self._run_stopped():
            log.warning("Ignoring executePoseGoal while robot is runstopped")
            self._cancel_pose_playback()
            return
        await self.switch_to_navigation_mode()
        if self._run_stopped():
            self._cancel_pose_playback()
            return
        if self.is_already_at_pose(pose):
            self._skip_pose()
            return
        self.stop_execution()
        self.pose_goal = self.make_pose_goal(pose, 1.5)
        token = _GoalToken()
        self.pose_goal_id = token
        status, result = await self._run_goal(
            self.trajectory_client, self.pose_goal, token
        )
        if status == GoalStatus.STATUS_SUCCEEDED:
            if result.error_code == 0:
                self.forward.playback_poses_result(
                    action_state(MovementState.SUCCESS, "info")
                )
        else:
            error_code = result.error_code if result is not None else -4
            state = MovementState.CANCEL if error_code == 0 else MovementState.FAIL
            self.forward.playback_poses_result(action_state(state, "error"))

    async def execute_pose_goals(self, poses: list) -> None:
        if self._run_stopped():
            log.warning("Ignoring executePoseGoals while robot is runstopped")
            self._cancel_pose_playback()
            return
        await self.switch_to_navigation_mode()
        if self._run_stopped():
            self._cancel_pose_playback()
            return
        if poses and all(self.is_already_at_pose(p) for p in poses):
            self._skip_pose()
            return
        self.stop_execution()
        self._clear_pose_watchdog()
        goal, cumulative = self.make_pose_goals(poses, 1.5)
        self.pose_goal = goal
        self.forward.playback_poses_result(
            action_state(MovementState.EXECUTING, "info")
        )
        token = _GoalToken()
        self.pose_goal_id = token

        if cumulative > 0:

            def watchdog():
                self.pose_goal_watchdog = None
                if self.pose_goal_id is not token:
                    return
                log.warning(
                    "Trajectory watchdog expired (%.2fs). Evaluating robot pose...",
                    cumulative * 1.1,
                )
                at_final = self.is_already_at_pose(poses[-1])
                self._cancel(token)
                self.pose_goal = None
                self.pose_goal_id = None
                if at_final:
                    self.forward.playback_poses_result(
                        action_state(MovementState.SUCCESS, "info")
                    )
                else:
                    self.forward.playback_poses_result(
                        action_state(MovementState.FAIL, "error")
                    )

            self.pose_goal_watchdog = self.loop.call_later(cumulative * 1.1, watchdog)

        status, result = await self._run_goal(self.trajectory_client, goal, token)
        self._clear_pose_watchdog()
        if self.pose_goal_id is not token:
            return
        self.pose_goal = None
        self.pose_goal_id = None
        if status == GoalStatus.STATUS_SUCCEEDED and result.error_code == 0:
            self.forward.playback_poses_result(
                action_state(MovementState.SUCCESS, "info")
            )
        elif status == GoalStatus.STATUS_SUCCEEDED:
            self.forward.playback_poses_result(
                action_state(MovementState.FAIL, "error")
            )
        else:
            error_code = result.error_code if result is not None else -4
            state = MovementState.CANCEL if error_code == 0 else MovementState.FAIL
            self.forward.playback_poses_result(action_state(state, "error"))

    async def execute_incremental_move(self, joint: str, increment: float) -> None:
        if self._run_stopped():
            log.warning("Ignoring executeIncrementalMove while robot is runstopped")
            return
        await self.switch_to_navigation_mode()
        if self.joint_state is None:
            raise RuntimeError("jointState is undefined")
        current = (
            0.0
            if joint in ("translate_mobile_base", "rotate_mobile_base")
            else self.get_joint_value(joint)
        )
        if current is None:
            log.warning("No position for %s; ignoring incremental move", joint)
            return
        self.pose_goal = self.make_pose_goal({joint: current + increment})
        status, result = await self._run_goal(
            self.trajectory_client, self.pose_goal, _GoalToken()
        )
        log.info("Incremental move on %s finished with status %s", joint, status)
        self.pose_goal = None
        self.pose_goal_id = None

    def execute_move_base_goal(self, pose: dict) -> None:
        if self._run_stopped():
            log.warning("Ignoring executeMoveBaseGoal while robot is runstopped")
            return
        if self.move_base_client is None:
            log.error("nav2_msgs is not installed; cannot navigate")
            return
        self.toggle_base_only_collision(False)
        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = "map"
        set_message_fields(goal.pose.pose, pose)
        self.move_base_goal = goal
        self.move_base_status_watching = True
        self.move_base_status_seen_active = False
        self.move_base_status_last_emitted = None
        self.move_base_terminal_baseline = None
        self._emit_move_base_result(action_state(NAVIGATION_EXECUTING, "info"))
        token = _GoalToken()
        self.move_base_goal_id = token

        def on_feedback(_feedback):
            # Feedback proves the goal is live even if the status topic lags.
            self.loop.call_soon_threadsafe(
                setattr, self, "move_base_status_seen_active", True
            )

        async def run():
            status, _result = await self._run_goal(
                self.move_base_client, goal, token, on_feedback
            )
            if self.move_base_goal_id is not token:
                return  # superseded or canceled locally; that path already reported
            if status == GoalStatus.STATUS_SUCCEEDED:
                self._emit_move_base_result(
                    action_state(NAVIGATION_SUCCEEDED, "success")
                )
            elif status == GoalStatus.STATUS_CANCELED:
                self._emit_move_base_result(action_state(NAVIGATION_CANCELED, "error"))
            else:
                self._emit_move_base_result(action_state(NAVIGATION_FAILED, "error"))
            self.toggle_base_only_collision(True)

        self._spawn(run())

    # ------------------------------------------------------------- stopping

    def stop_execution(self, stop_trajectory_client: bool = False) -> None:
        if stop_trajectory_client:
            self.stop_trajectory_client()
            if self.cmd_vel is not None:
                self.cmd_vel.publish(self._twist())
            self.ee_cmd_vel.publish(self._twist())
        self.stop_move_base_client()

    def _clear_pose_watchdog(self) -> None:
        if self.pose_goal_watchdog is not None:
            self.pose_goal_watchdog.cancel()
            self.pose_goal_watchdog = None

    def stop_trajectory_client(self) -> None:
        self._clear_pose_watchdog()
        if self.pose_goal is not None or self.pose_goal_id is not None:
            self._cancel(self.pose_goal_id)
            self.pose_goal = None
            self.pose_goal_id = None
            self.forward.playback_poses_result(
                action_state(MovementState.CANCEL, "error")
            )

    def stop_move_base_client(self) -> None:
        if self.move_base_client is None:
            return
        had_active_goal = (
            self.move_base_goal_id is not None or self.move_base_status_watching
        )
        if self.move_base_cancel_all.service_is_ready():
            # Zero goal id and zero stamp: cancel every goal on the server.
            self.move_base_cancel_all.call_async(CancelGoal.Request())
        self._cancel(self.move_base_goal_id)
        if had_active_goal:
            self.toggle_base_only_collision(True)
            self._emit_move_base_result(action_state(NAVIGATION_CANCELED, "error"))
