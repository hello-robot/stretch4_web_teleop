#!/usr/bin/env python3

import math
import sys
import threading
from typing import Dict, Union

import cv2
import numpy as np
import numpy.typing as npt
import PyKDL  # TODO: This can be removed, as it is only used to perform a transformation that can be done with numpy
import rclpy
import yaml
from cv_bridge import CvBridge
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from rclpy.time import Time
from sensor_msgs.msg import CameraInfo, CompressedImage, Image, JointState, PointCloud2
from std_srvs.srv import SetBool, Trigger

from stretch4_web_teleop_helpers.conversions import (
    cv2_image_to_ros_msg,
    ros_msg_to_cv2_image,
)

# TODO: Add docstrings to this file.


class ConfigureVideoStreams(Node):
    BACKGROUND_COLOR = (200, 200, 200)
    
    def __init__(
        self,
        params_file,
        use_overhead: bool = True,
        use_gripper: bool = True,
        use_pointcloud: bool = True,
        use_compressed_image: bool = True,
        target_fps: float = 15.0,
        verbose: bool = False,
    ):
        """
        Initialize the ConfigureVideoStreams class.

        Parameters
        ----------
        node: The ROS node that this class is a part of.
        params_file: The path to the YAML file containing the image parameters.
        use_overhead: If True, subscribe to the overhead camera image messages.
        use_gripper: If True, subscribe to the gripper camera image messages.
        use_pointcloud: If True, subscribe to the raw pointcloud message. If False,
            subscribe to the aligned depth image message.
        use_compressed_image: If True, subscribe to the compressed image messages.
            If False, subscribe to the raw image messages.
        target_fps: The target frames per second for the video streams.
        verbose: If True, print additional log messages.
        """
        super().__init__("configure_video_streams")

        with open(params_file, "r") as params:
            self.image_params = yaml.safe_load(params)
        self.verbose = verbose
        self.use_overhead = use_overhead
        self.use_gripper = use_gripper
        self.target_fps = target_fps

        # These are parameters the web app uses to determine which features to
        # enabled. They are not used in this node itself.
        self.declare_parameter("stretch_tool", rclpy.Parameter.Type.STRING)

        # Loaded params for each video stream
        if self.use_overhead:
            self.overhead_params = (
                self.image_params["overhead"]
                if "overhead" in self.image_params
                else None
            )
            self.overhead_images: Dict[str, npt.NDArray] = {}
            self.overhead_camera_rgb_image = None
        if self.use_gripper:
            self.gripper_params = (
                self.image_params["gripper"] if "gripper" in self.image_params else None
            )
            self.expanded_gripper_params = (
                self.image_params["expandedGripper"]
                if "expandedGripper" in self.image_params
                else None
            )
            self.gripper_images: Dict[str, npt.NDArray] = {}
            self.gripper_camera_rgb_image = None
            self.latest_gripper_camera_rgb_image_lock = None

        self.cv_bridge = CvBridge()
        self.aruco_detector = None
        # https://github.com/hello-robot/stretchpy/blob/feature/aruco_marker_detection/docs/arucos.md#known-markers
        self.gripper_aruco_ids = {
            "finger_left": 200,
            "finger_right": 201,
        }

        # Stores the camera projection matrix
        if self.use_gripper:
            self.gripper_P = None

        # Compressed Image publishers
        if self.use_overhead:
            self.publisher_overhead_cmp = self.create_publisher(
                CompressedImage, "/navigation_camera/image_raw/rotated/compressed", 15
            )
        if self.use_gripper:
            self.publisher_gripper_cmp = self.create_publisher(
                CompressedImage,
                "/gripper_camera/image_raw/cropped/compressed",
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
            )

        # Default image perspectives
        if self.use_overhead:
            self.overhead_camera_perspective = "right"
        if self.use_gripper:
            self.gripper_camera_perspective = "oak"

        # Subscribers
        if self.use_overhead:
            self.latest_overhead_camera_rgb_image = None
            self.latest_overhead_camera_rgb_image_lock = threading.Lock()
            self.right_camera_rgb_subscriber = self.create_subscription(
                Image,
                "/cameras_head/right/image_raw",
                self.right_navigation_camera_cb,
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                callback_group=MutuallyExclusiveCallbackGroup(),
            )
            self.center_camera_rgb_subscriber = self.create_subscription(
                Image,
                "/cameras_head/center/image_raw",
                self.center_navigation_camera_cb,
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                callback_group=MutuallyExclusiveCallbackGroup(),
            )
            self.left_camera_rgb_subscriber = self.create_subscription(
                Image,
                "/cameras_head/left/image_raw",
                self.left_navigation_camera_cb,
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                callback_group=MutuallyExclusiveCallbackGroup(),
            )
            self.use_right_camera_service = self.create_service(
                Trigger, "use_right_camera", self.use_right_camera_callback
            )
            self.use_left_camera_service = self.create_service(
                Trigger, "use_left_camera", self.use_left_camera_callback
            )
            self.use_center_camera_service = self.create_service(
                Trigger, "use_center_camera", self.use_center_camera_callback
            )

        if self.use_gripper:
            self.latest_gripper_camera_rgb_image = None
            self.latest_gripper_camera_rgb_image_lock = threading.Lock()
            self.expanded_gripper = False

            # Subscribe to the RGB ompressed image topic
            self.gripper_camera_rgb_subscriber = self.create_subscription(
                CompressedImage if use_compressed_image else Image,
                "/cameras_gripper/right/image_raw"
                + ("/compressed" if use_compressed_image else ""),
                self.gripper_camera_rgb_cb,
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                callback_group=MutuallyExclusiveCallbackGroup(),
            )

            # Services for expanding the gripper image
            self.expanded_gripper_service = self.create_service(
                SetBool, "expanded_gripper", self.expanded_gripper_callback
            )

            # Subscribe to the depth image topic
            self.latest_gripper_camera_depth_image = None
            self.latest_gripper_camera_depth_image_lock = threading.Lock()
            if use_pointcloud:
                self.gripper_depth_subscriber = self.create_subscription(
                    PointCloud2,
                    "/gripper_camera/depth/color/points",
                    self.gripper_camera_depth_cb,
                    QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                    callback_group=MutuallyExclusiveCallbackGroup(),
                )
            else:
                self.gripper_depth_subscriber = self.create_subscription(
                    CompressedImage if use_compressed_image else Image,
                    "/gripper_camera/aligned_depth_to_color/image_raw"
                    + ("/compressedDepth" if use_compressed_image else ""),
                    self.gripper_camera_depth_cb,
                    QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                    callback_group=MutuallyExclusiveCallbackGroup(),
                )
            self.gripper_camera_info_subscriber = self.create_subscription(
                CameraInfo,
                "/gripper_camera/color/camera_info",
                self.gripper_camera_info_cb,
                QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT),
                callback_group=MutuallyExclusiveCallbackGroup(),
            )
            self.joint_state_subscription = self.create_subscription(
                JointState,
                "/stretch/joint_states",
                self.joint_state_cb,
                1,
                callback_group=MutuallyExclusiveCallbackGroup(),
            )

        self.roll_value = 0.0

    # https://github.com/ros/geometry2/blob/noetic-devel/tf2_sensor_msgs/src/tf2_sensor_msgs/tf2_sensor_msgs.py#L44
    def transform_to_kdl(self, t):
        return PyKDL.Frame(
            PyKDL.Rotation.Quaternion(
                t.transform.rotation.x,
                t.transform.rotation.y,
                t.transform.rotation.z,
                t.transform.rotation.w,
            ),
            PyKDL.Vector(
                t.transform.translation.x,
                t.transform.translation.y,
                t.transform.translation.z,
            ),
        )

    # https://github.com/ros/geometry2/blob/noetic-devel/tf2_sensor_msgs/src/tf2_sensor_msgs/tf2_sensor_msgs.py#L52
    def do_transform_cloud(self, cloud, transform):
        t_kdl = self.transform_to_kdl(transform)
        points_out = []
        points = cloud.to_array()
        for p_in in points:
            p_out = t_kdl * PyKDL.Vector(p_in[0], p_in[1], p_in[2])
            points_out.append([p_out[0], p_out[1], p_out[2]])
        return np.array(points_out)

    def gripper_camera_info_cb(self, msg):
        self.gripper_P = np.array(msg.p).reshape(3, 4)
        # self.camera_info_subscriber.destroy()

    def use_right_camera_callback(self, req, res):
        self.get_logger().info("Use right camera service")
        self.overhead_camera_perspective = "right"
        res.success = True
        return res

    def use_left_camera_callback(self, req, res):
        self.get_logger().info("Use left camera service")
        self.overhead_camera_perspective = "left"
        res.success = True
        return res

    def use_center_camera_callback(self, req, res):
        self.get_logger().info("Use center camera service")
        self.overhead_camera_perspective = "center"
        res.success = True
        return res

    def expanded_gripper_callback(self, req, res):
        self.get_logger().info(f"Expanded gripper service: {req.data}")
        self.expanded_gripper = req.data
        res.success = True
        return res

    def crop_image(self, image, params):
        if params["x_min"] is None:
            raise ValueError("Crop x_min is not defined!")
        if params["x_max"] is None:
            raise ValueError("Crop x_max is not defined!")
        if params["y_min"] is None:
            raise ValueError("Crop y_min is not defined!")
        if params["y_max"] is None:
            raise ValueError("Crop y_max is not defined!")

        x_min = params["x_min"]
        x_max = params["x_max"]
        y_min = params["y_min"]
        y_max = params["y_max"]
        width = x_max - x_min
        height = y_max - y_min

        # It is possible that the "crop" expands the image beyond its original dimensions.
        # Hence, we create a new image and fill it with a constant value for the background.
        background_color = (
            self.BACKGROUND_COLOR
            if image.shape[-1] == 3
            else (*self.BACKGROUND_COLOR, 255)
        )
        cropped_image = (
            np.repeat(background_color, width * height, axis=0)
            .reshape(height, width, image.shape[-1])
            .astype(np.uint8)
        )

        # x and y are swapped, since the first index is the rows (y) and the second index is the columns (x)
        cropped_image[
            max(-y_min, 0) : min(height - (y_max - image.shape[0]), height),
            max(-x_min, 0) : min(width - (x_max - image.shape[1]), width),
        ] = image[
            max(y_min, 0) : min(y_max, image.shape[0]),
            max(x_min, 0) : min(x_max, image.shape[1]),
        ]
        return cropped_image

    # https://stackoverflow.com/questions/44865023/how-can-i-create-a-circular-mask-for-a-numpy-array
    def create_circular_mask(self, h, w, center=None, radius=None):
        if center is None:  # use the middle of the image
            center = (int(w / 2), int(h / 2))
        if (
            radius is None
        ):  # use the smallest distance between the center and image walls
            radius = min(center[0], center[1], w - center[0], h - center[1])

        Y, X = np.ogrid[:h, :w]
        dist_from_center = np.sqrt((X - center[0]) ** 2 + (Y - center[1]) ** 2)

        mask = dist_from_center <= radius
        return mask

    def mask_image(self, image, params):
        if params["width"] is None:
            raise ValueError("Mask width is not defined!")
        if params["height"] is None:
            raise ValueError("Mask height is not defined!")

        w = params["width"]
        h = params["height"]
        center = (
            (params["center"]["x"], params["center"]["y"]) if params["center"] else None
        )
        radius = params["radius"]

        mask = self.create_circular_mask(h, w, center, radius)
        img = image.copy()
        background_color = (
            self.BACKGROUND_COLOR
            if image.shape[-1] == 3
            else (*self.BACKGROUND_COLOR, 255)
        )
        img[~mask] = background_color
        return img

    def rotate_image(self, image, value):
        if value == "ROTATE_90_CLOCKWISE":
            return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
        elif value == "ROTATE_180":
            return cv2.rotate(image, cv2.ROTATE_180)
        elif value == "ROTATE_90_COUNTERCLOCKWISE":
            return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
        else:
            raise ValueError(
                "Invalid rotate image value: options are ROTATE_90_CLOCKWISE, ROTATE_180, or ROTATE_90_COUNTERCLOCKWISE"
            )

    def configure_images(self, rgb_image, params):
        color_transform = (
            cv2.COLOR_BGR2RGB if rgb_image.shape[-1] == 3 else cv2.COLOR_BGRA2RGBA
        )
        rgb_image = cv2.cvtColor(rgb_image, color_transform)
        if params:
            if params["crop"]:
                rgb_image = self.crop_image(rgb_image, params["crop"])
            if params["mask"]:
                rgb_image = self.mask_image(rgb_image, params["mask"])
            if params["rotate"]:
                rgb_image = self.rotate_image(rgb_image, params["rotate"])
        return rgb_image

    def gripper_camera_cb(self, ros_image):
        with self.latest_gripper_camera_rgb_image_lock:
            self.latest_gripper_camera_rgb_image = ros_image

    def gripper_camera_depth_cb(
        self,
        depth_msg: Union[CompressedImage, Image, PointCloud2],
    ):
        if self.verbose:
            start_time = self.get_clock().now()
            lag = (
                start_time - Time.from_msg(depth_msg.header.stamp)
            ).nanoseconds / 1.0e9
            self.get_logger().info(
                f"Gripper Depth recv lag: {lag: .3f} seconds",
                throttle_duration_sec=1.0,
            )

        with self.latest_gripper_camera_depth_image_lock:
            self.latest_gripper_camera_depth_image = depth_msg

    def gripper_camera_rgb_cb(
        self,
        ros_image: Union[CompressedImage, Image],
    ):
        if self.verbose:
            start_time = self.get_clock().now()
            lag = (
                start_time - Time.from_msg(ros_image.header.stamp)
            ).nanoseconds / 1.0e9
            self.get_logger().info(
                f"Gripper RGB recv lag: {lag: .3f} seconds",
                throttle_duration_sec=1.0,
            )

        with self.latest_gripper_camera_rgb_image_lock:
            self.latest_gripper_camera_rgb_image = ros_image

    def process_gripper_image(
        self,
        ros_image: Union[CompressedImage, Image],
    ):
        image = ros_msg_to_cv2_image(ros_image, self.cv_bridge)
        if isinstance(ros_image, CompressedImage):
            image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        else:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        if self.expanded_gripper:
            # Compute and publish the expanded gripper image
            gripper_camera_rgb_image = self.configure_images(
                image, self.expanded_gripper_params[self.gripper_camera_perspective]
            )
            self.gripper_camera_rgb_image = self.rotate_image_around_center(
                gripper_camera_rgb_image, -1 * self.roll_value
            )
            self.publish_compressed_msg(
                self.gripper_camera_rgb_image,
                self.publisher_gripper_cmp,
                ros_image.header,
            )
        else:
            # Compute and publish the standard gripper image
            gripper_camera_rgb_image = self.configure_images(
                image, self.gripper_params[self.gripper_camera_perspective]
            )
            self.gripper_camera_rgb_image = self.rotate_image_around_center(
                gripper_camera_rgb_image, -1 * self.roll_value
            )
            self.publish_compressed_msg(
                self.gripper_camera_rgb_image,
                self.publisher_gripper_cmp,
                ros_image.header,
            )

    def right_navigation_camera_cb(self, ros_image):
        if self.verbose:
            start_time = self.get_clock().now()
            lag = (
                start_time - Time.from_msg(ros_image.header.stamp)
            ).nanoseconds / 1.0e9
            self.get_logger().info(
                f"Navigation RGB recv lag: {lag: .3f} seconds",
                throttle_duration_sec=1.0,
            )

        if self.overhead_camera_perspective == "right":
            with self.latest_overhead_camera_rgb_image_lock:
                self.latest_overhead_camera_rgb_image = ros_image

    def center_navigation_camera_cb(self, ros_image):
        if self.verbose:
            start_time = self.get_clock().now()
            lag = (
                start_time - Time.from_msg(ros_image.header.stamp)
            ).nanoseconds / 1.0e9
            self.get_logger().info(
                f"Navigation RGB recv lag: {lag: .3f} seconds",
                throttle_duration_sec=1.0,
            )

        if self.overhead_camera_perspective == "center":
            with self.latest_overhead_camera_rgb_image_lock:
                self.latest_overhead_camera_rgb_image = ros_image

    def left_navigation_camera_cb(self, ros_image):
        if self.verbose:
            start_time = self.get_clock().now()
            lag = (
                start_time - Time.from_msg(ros_image.header.stamp)
            ).nanoseconds / 1.0e9
            self.get_logger().info(
                f"Navigation RGB recv lag: {lag: .3f} seconds",
                throttle_duration_sec=1.0,
            )

        if self.overhead_camera_perspective == "left":
            with self.latest_overhead_camera_rgb_image_lock:
                self.latest_overhead_camera_rgb_image = ros_image

    def process_navigation_image(self, ros_image):
        image = ros_msg_to_cv2_image(ros_image, self.cv_bridge)
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        self.overhead_camera_rgb_image = self.configure_images(
            image, self.overhead_params[self.overhead_camera_perspective]
        )
        self.publish_compressed_msg(
            self.overhead_camera_rgb_image,
            self.publisher_overhead_cmp,
            ros_image.header,
        )

    def rotate_image_around_center(self, image, angle):
        image_center = tuple(np.array(image.shape[1::-1]) / 2)
        rot_mat = cv2.getRotationMatrix2D(image_center, math.degrees(angle), 1.0)
        result = cv2.warpAffine(
            image,
            rot_mat,
            image.shape[1::-1],
            flags=cv2.INTER_LINEAR,
            borderValue=self.BACKGROUND_COLOR,
        )
        return result

    def joint_state_cb(self, joint_state):
        if "wrist_roll_joint" in joint_state.name:
            roll_index = joint_state.name.index("wrist_roll_joint")
            self.roll_value = joint_state.position[roll_index]

    def publish_compressed_msg(self, image, publisher, header):
        msg = cv2_image_to_ros_msg(image, compress=True, bridge=self.cv_bridge)
        msg.header.stamp = header.stamp
        publisher.publish(msg)

    def run(self):
        rate = self.create_rate(self.target_fps)
        while rclpy.ok():
            # Process the navigation image
            if self.use_overhead:
                with self.latest_overhead_camera_rgb_image_lock:
                    overhead_camera_rgb_image = self.latest_overhead_camera_rgb_image
                    self.latest_overhead_camera_rgb_image = None
                if overhead_camera_rgb_image is not None:
                    self.process_navigation_image(overhead_camera_rgb_image)

            # Process the gripper image
            if self.use_gripper:
                with self.latest_gripper_camera_rgb_image_lock:
                    gripper_rgb_image = self.latest_gripper_camera_rgb_image
                    self.latest_gripper_camera_rgb_image = None
                if gripper_rgb_image is not None:
                    self.process_gripper_image(gripper_rgb_image)

            rate.sleep()


if __name__ == "__main__":
    rclpy.init()
    print(sys.argv)
    node = ConfigureVideoStreams(
        params_file=sys.argv[1],
        use_overhead=sys.argv[2] == "True",
        use_gripper=sys.argv[3] == "True",
    )
    print("Publishing reconfigured video stream")
    # Use a MultiThreadedExecutor so that subscriptions, actions, etc. can be
    # processed in parallel.
    executor = MultiThreadedExecutor(num_threads=8)

    # Spin in the background
    spin_thread = threading.Thread(
        target=rclpy.spin,
        args=(node,),
        kwargs={"executor": executor},
        daemon=True,
    )
    spin_thread.start()

    # Run video stream configuration
    try:
        node.run()
    except KeyboardInterrupt:
        pass

    # Terminate this node
    node.destroy_node()
    rclpy.shutdown()
    # Join the spin thread (so it is spinning in the main thread)
    spin_thread.join()

    rclpy.spin(node, executor=executor)
