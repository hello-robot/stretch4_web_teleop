#!/usr/bin/env python3
"""Stand-in for the Stretch driver and cameras, used by the latency benchmark.

Run it in place of the real robot bringup. It provides just enough of the ROS
graph for the robot peer to come up and serve an operator:

  * ``stretch_driver``: ``mode`` / ``tool_info.*`` parameters, ``/mode``,
    ``/is_runstopped``, ``/battery``, ``/joint_states`` (with a
    ``latency_probe`` joint whose position is the publish wall time),
    ``/joint_states_diagnostics``, and the Trigger / SetBool services the
    interface calls.
  * ``/follow_joint_trajectory``: accepts and succeeds immediately.
  * Two compressed camera topics whose frames carry their publish wall time
    as a 32-cell barcode across the top of the image (see ``stamp_image``).
  * A probe that records, as JSON lines, when each operator command reaches
    ROS, so the benchmark can pair it with the operator's send time.

Everything runs on one machine, so wall-clock times from this process and from
the operator browser are directly comparable.
"""

import argparse
import json
import math
import threading
import time

import cv2
import numpy as np
import rclpy
from control_msgs.action import FollowJointTrajectory
from control_msgs.msg import JointJog
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from geometry_msgs.msg import Twist
from rcl_interfaces.msg import SetParametersResult
from rclpy.action import ActionServer, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import BatteryState, CompressedImage, JointState
from std_msgs.msg import Bool, String
from std_srvs.srv import SetBool, Trigger

BARCODE_CELLS = 32
BARCODE_BAND_FRACTION = 0.06

JOINTS = [
    "lift_joint",
    "arm_l1_joint",
    "arm_l2_joint",
    "arm_l3_joint",
    "arm_l4_joint",
    "wrist_yaw_joint",
    "wrist_pitch_joint",
    "wrist_roll_joint",
    "gripper_joint",
    "latency_probe",
]


def barcode_bits(stamp_ms: int) -> list[int]:
    """24-bit millisecond stamp followed by an 8-bit xor checksum, MSB first."""
    value = stamp_ms & 0xFFFFFF
    check = (value ^ (value >> 8) ^ (value >> 16)) & 0xFF
    word = (value << 8) | check
    return [(word >> (31 - i)) & 1 for i in range(BARCODE_CELLS)]


def stamp_image(image: np.ndarray, stamp_ms: int) -> None:
    """Paint the barcode for ``stamp_ms`` into the top band of ``image`` in place."""
    height, width = image.shape[:2]
    band = max(8, int(height * BARCODE_BAND_FRACTION))
    for i, bit in enumerate(barcode_bits(stamp_ms)):
        x0 = (i * width) // BARCODE_CELLS
        x1 = ((i + 1) * width) // BARCODE_CELLS
        image[:band, x0:x1] = 255 if bit else 0


class Camera:
    """Generates moving frames, stamps them, JPEG-encodes and publishes them."""

    def __init__(self, node: Node, topic: str, width: int, height: int, qos):
        self.publisher = node.create_publisher(CompressedImage, topic, qos)
        self.width = width
        self.height = height
        # Diagonal gradient: pixel (y, x) = (x + y) mod 256.
        self.base = (np.add.outer(np.arange(height), np.arange(width)) % 256).astype(
            np.uint8
        )
        self.rng = np.random.default_rng(0)
        self.frame = 0

    def publish(self) -> None:
        self.frame += 1
        shift = (self.frame * 7) % 256
        gray = (self.base + shift).astype(np.uint8)
        image = np.dstack([gray, np.roll(gray, self.frame * 3, axis=1), 255 - gray])
        # A little sensor-like noise so the video encoder has real work to do.
        noise = self.rng.integers(
            0, 12, size=(self.height // 4, self.width // 4, 1), dtype=np.uint8
        )
        image = cv2.add(
            image,
            cv2.resize(noise, (self.width, self.height))[..., None].repeat(3, axis=2),
        )
        stamp_image(image, int(time.time() * 1000))
        ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            return
        msg = CompressedImage()
        msg.format = "jpeg"
        msg.data = jpeg.tobytes()
        now = time.time()
        msg.header.stamp.sec = int(now)
        msg.header.stamp.nanosec = int((now % 1) * 1e9)
        msg.header.frame_id = "camera"
        self.publisher.publish(msg)


class ProbeLog:
    """Thread-safe JSON-lines writer for command arrival times."""

    def __init__(self, path: str):
        self.lock = threading.Lock()
        self.file = open(path, "a", buffering=1)

    def write(self, **record) -> None:
        record["t"] = time.time()
        with self.lock:
            self.file.write(json.dumps(record) + "\n")


class MockDriver(Node):
    def __init__(self, probe: ProbeLog, fps: float):
        super().__init__("stretch_driver")
        self.probe = probe
        group = ReentrantCallbackGroup()

        self.declare_parameter("mode", "position")
        self.declare_parameter("tool_info.is_actuated", True)
        self.declare_parameter("tool_info.urdf_range", [0.0, 0.2])
        self.add_on_set_parameters_callback(self.on_params)

        self.mode_pub = self.create_publisher(String, "/mode", 1)
        self.runstop_pub = self.create_publisher(Bool, "/is_runstopped", 1)
        self.battery_pub = self.create_publisher(BatteryState, "/battery", 1)
        self.joint_pub = self.create_publisher(JointState, "/joint_states", 10)
        self.diag_pub = self.create_publisher(
            DiagnosticArray, "/joint_states_diagnostics", 1
        )

        for name in [
            "/home_the_robot",
            "/seed_localization",
            "/use_left_camera",
            "/use_right_camera",
            "/use_center_camera",
        ]:
            self.create_service(
                Trigger,
                name,
                self.service_logger(name, self.on_trigger),
                callback_group=group,
            )
        for name in ["/runstop_the_robot", "/joystick_control", "/expanded_gripper"]:
            self.create_service(
                SetBool,
                name,
                self.service_logger(name, self.on_set_bool),
                callback_group=group,
            )

        self.trajectory_server = ActionServer(
            self,
            FollowJointTrajectory,
            "/follow_joint_trajectory",
            execute_callback=self.on_trajectory,
            goal_callback=self.on_trajectory_goal,
            callback_group=group,
        )

        reliable = QoSProfile(depth=15)
        best_effort = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
        self.cameras = [
            # Navigation camera: rotated to portrait, reliable QoS, like configure_video_streams.py
            Camera(
                self,
                "/navigation_camera/image_raw/rotated/compressed",
                720,
                1280,
                reliable,
            ),
            # Gripper camera: cropped landscape, best-effort depth 1
            Camera(
                self,
                "/gripper_camera/image_raw/cropped/compressed",
                1024,
                768,
                best_effort,
            ),
        ]
        self.create_timer(1.0 / fps, self.publish_cameras, callback_group=group)
        self.create_timer(1.0 / 30.0, self.publish_joints, callback_group=group)
        self.create_timer(1.0, self.publish_slow, callback_group=group)

        self.create_subscription(
            Twist,
            "/teleop/cmd_vel",
            lambda m: self.log_twist("/teleop/cmd_vel", m),
            10,
            callback_group=group,
        )
        self.create_subscription(
            Twist,
            "/cmd_vel",
            lambda m: self.log_twist("/cmd_vel", m),
            10,
            callback_group=group,
        )
        self.create_subscription(
            Twist,
            "/ee_cmd_vel",
            lambda m: self.log_twist("/ee_cmd_vel", m),
            10,
            callback_group=group,
        )
        self.create_subscription(
            JointJog,
            "/teleop/joint_vel",
            lambda m: self.log_jog("/teleop/joint_vel", m),
            10,
            callback_group=group,
        )
        self.create_subscription(
            JointJog,
            "/joint_vel",
            lambda m: self.log_jog("/joint_vel", m),
            10,
            callback_group=group,
        )

    def service_logger(self, name: str, handler):
        def call(request, response):
            self.probe.write(topic=name, value=getattr(request, "data", None))
            return handler(request, response)

        return call

    def on_params(self, params):
        for param in params:
            if param.name == "mode":
                self.probe.write(topic="param:mode", value=param.value)
                self.mode_pub.publish(String(data=param.value))
        return SetParametersResult(successful=True)

    def on_trigger(self, request, response):
        response.success = True
        response.message = "ok"
        return response

    def on_set_bool(self, request, response):
        response.success = True
        response.message = "ok"
        return response

    def on_trajectory_goal(self, goal):
        point = goal.trajectory.points[0] if goal.trajectory.points else None
        self.probe.write(
            topic="/follow_joint_trajectory",
            value=list(point.positions) if point else [],
        )
        return GoalResponse.ACCEPT

    def on_trajectory(self, goal_handle):
        goal_handle.succeed()
        result = FollowJointTrajectory.Result()
        result.error_code = 0
        return result

    def log_twist(self, topic: str, msg: Twist) -> None:
        self.probe.write(
            topic=topic, value=[msg.linear.x, msg.linear.y, msg.linear.z, msg.angular.z]
        )

    def log_jog(self, topic: str, msg: JointJog) -> None:
        self.probe.write(
            topic=topic, value=list(msg.velocities), joints=list(msg.joint_names)
        )

    def publish_cameras(self) -> None:
        for camera in self.cameras:
            camera.publish()

    def publish_joints(self) -> None:
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = JOINTS
        positions = [0.3, 0.05, 0.05, 0.05, 0.05, 0.0, 0.0, 0.0, 0.0]
        # Wall time, folded so a float64 keeps sub-microsecond resolution.
        positions.append(math.fmod(time.time(), 100000.0))
        msg.position = positions
        msg.velocity = [0.0] * len(JOINTS)
        msg.effort = [0.0] * len(JOINTS)
        self.joint_pub.publish(msg)

    def publish_slow(self) -> None:
        self.mode_pub.publish(String(data=self.get_parameter("mode").value))
        self.runstop_pub.publish(Bool(data=False))
        battery = BatteryState()
        battery.percentage = 0.8
        battery.power_supply_status = 2
        self.battery_pub.publish(battery)
        homed = DiagnosticStatus(
            name="is_homed", values=[KeyValue(key="lift_joint", value="True")]
        )
        self.diag_pub.publish(DiagnosticArray(status=[homed]))


class ParamNode(Node):
    """A node that only exists to own parameters the interface reads."""

    def __init__(self, name: str, params: dict):
        super().__init__(name)
        for key, value in params.items():
            self.declare_parameter(key, value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--probe-log", required=True, help="JSON-lines file for command arrival times"
    )
    parser.add_argument(
        "--fps", type=float, default=15.0, help="camera publish rate (Hz)"
    )
    args, ros_args = parser.parse_known_args()

    rclpy.init(args=ros_args)
    probe = ProbeLog(args.probe_log)
    nodes = [
        MockDriver(probe, args.fps),
        ParamNode(
            "configure_video_streams_gripper",
            {"stretch_tool": "eoa_wrist_dw4_tool_sg4"},
        ),
        ParamNode("ee_velocity_safety_filter", {"max_ee_speed": 0.15}),
    ]
    executor = MultiThreadedExecutor(num_threads=6)
    for node in nodes:
        executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        for node in nodes:
            node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
