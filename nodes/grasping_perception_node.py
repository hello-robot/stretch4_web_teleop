#!/usr/bin/env python3
"""
ROS 2 Grasping Perception Node for Stretch 4.

Processes gripper camera RGB-D streams and generates real-time perception visual overlays:
1. Tool Grasp Center Point (TCP) Crosshair Reticle with dynamic color state feedback (Int8):
   - 0 (RED): Default state (<100 points within range).
   - 1 (YELLOW): 100 - 1000 points within 4cm window centered on reticle.
   - 2 (GREEN): >1000 points within window and near distance (<0.20m).
2. Compliant Fingertip Swept Volume Manifold (translucent mesh overlay).
3. RGB-D Surface Point Heatmap (JET colormap).

Emits reticle state metadata and annotated compressed video stream.
"""

import os
import sys
import threading
from typing import Any

import cv2
import numpy as np
import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CameraInfo, CompressedImage, Image
from std_msgs.msg import Int8
from std_srvs.srv import SetBool, Trigger
from stretch4_urdf import get_transform, get_urdf_from_robot_params

# Ensure current node directory is on sys.path for local module imports
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from overlay_utils import (
    DEFAULT_TCP_Z,
    GRASP_Z_MAX_DEFAULT,
    N_POINTS_MIN_GREEN,
    N_POINTS_MIN_YELLOW,
    RETICLE_RADIUS_M,
    STATE_GREEN,
    STATE_RED,
    STATE_YELLOW,
    WINDOW_HALF_WIDTH_M,
    Z_NEAR_M,
    compute_reticle_pixel_radius,
    compute_reticle_window_mask,
    compute_swept_volume_mask,
    draw_reticle_overlay,
    evaluate_reticle_depth_state,
    project_point_to_pixel,
    project_points_to_pixels,
    render_depth_heatmap_overlay,
    render_swept_volume_manifold,
)
from stretch4_web_teleop_helpers.conversions import (
    cv2_image_to_ros_msg,
    ros_msg_to_cv2_image,
)

# Import compliant gripper modeling utilities
gripper_pkg_dir = os.path.join(
    os.path.expanduser("~"), "repos/stretch4_compliant_gripper/src"
)
if gripper_pkg_dir not in sys.path:
    sys.path.insert(0, gripper_pkg_dir)

try:
    from stretch4_gripper_modeling_and_control import calibration_utils as cu
    from stretch4_gripper_modeling_and_control.fingertip_visualizer import (
        FingertipVisualizer,
    )
    from stretch4_gripper_modeling_and_control.swept_volume_model import (
        SweptVolumeModel,
    )
except ImportError:
    cu = None
    FingertipVisualizer = None
    SweptVolumeModel = None

MAX_OPEN_PCT: float = 280.0  # Maximum physical gripper opening percentage


class GraspingPerceptionNode(Node):
    """
    ROS 2 Node handling real-time grasping perception data processing and overlay emission.
    """

    def __init__(self) -> None:
        """
        Initialize the node, buffers, subscribers, publishers, and services.

        Args:
            None.

        Returns:
            None.
        """
        super().__init__("grasping_perception_node")

        self.get_logger().info("Initializing Grasping Perception Node...")

        # Feature toggle states
        self.processing_enabled: bool = True
        self.show_swept_volume: bool = False
        self.show_depth_points: bool = False
        self.show_reticle: bool = True
        self.max_open: float = MAX_OPEN_PCT

        # State locks and image buffers
        self.image_lock = threading.Lock()
        self.latest_rgb_msg: CompressedImage | None = None
        self.cached_depth_img: np.ndarray | None = None

        # Camera calibration intrinsics (populated exclusively via /cameras_gripper/right/camera_info subscription)
        self.camera_matrix: np.ndarray | None = None
        self.distortion_coefficients: np.ndarray | None = None

        # Tool Grasp Center Point (TCP) projection
        self.grasp_center_2d: tuple[float, float] | None = None
        self.grasp_center_3d_cam: np.ndarray | None = None
        self.grasp_center_radius_px: float = 9.0

        # Pre-compute compliant fingertip swept volume trajectory geometry
        self.swept_volume_data: list[dict[str, Any]] = []
        self.grasp_z_max: float = GRASP_Z_MAX_DEFAULT

        # Real-time statistics & state
        self.num_window_pts: int = 0
        self.num_near_window_pts: int = 0
        self.reticle_state: int = STATE_RED

        # QoS Profiles
        sensor_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
        cb_group = MutuallyExclusiveCallbackGroup()

        # Subscriptions
        self.sub_rgb = self.create_subscription(
            CompressedImage,
            "/cameras_gripper/right/image_raw/compressed",
            self._rgb_cb,
            sensor_qos,
            callback_group=cb_group,
        )
        self.sub_depth = self.create_subscription(
            CompressedImage,
            "/cameras_gripper/stereo/image_raw/compressedDepth",
            self._depth_cb,
            sensor_qos,
            callback_group=cb_group,
        )
        self.sub_camera_info = self.create_subscription(
            CameraInfo,
            "/cameras_gripper/right/camera_info",
            self._camera_info_cb,
            sensor_qos,
            callback_group=cb_group,
        )

        # Publishers
        self.pub_reticle_state = self.create_publisher(
            Int8, "/grasping_perception/reticle_state", 10
        )
        self.pub_annotated_raw = self.create_publisher(
            Image, "/grasping_perception/annotated_image", 10
        )
        self.pub_annotated_img = self.create_publisher(
            CompressedImage, "/grasping_perception/annotated_image/compressed", 10
        )

        # Services
        self.srv_toggle_sv = self.create_service(
            Trigger,
            "/grasping_perception/toggle_swept_volume",
            self._toggle_swept_volume_cb,
        )
        self.srv_toggle_depth = self.create_service(
            Trigger,
            "/grasping_perception/toggle_depth_heatmap",
            self._toggle_depth_heatmap_cb,
        )
        self.srv_toggle_reticle = self.create_service(
            Trigger, "/grasping_perception/toggle_reticle", self._toggle_reticle_cb
        )
        self.srv_enable_processing = self.create_service(
            SetBool,
            "/grasping_perception/enable_processing",
            self._enable_processing_cb,
        )

        # Main processing timer (15 Hz)
        self.timer = self.create_timer(1.0 / 15.0, self._process_loop)

        self.get_logger().info(
            "Grasping Perception Node fully initialized and running."
        )

    def _camera_info_cb(self, msg: CameraInfo) -> None:
        """
        Handle incoming camera calibration intrinsics message.

        Args:
            msg: CameraInfo message containing calibration matrix and distortion coefficients.

        Returns:
            None.
        """
        if hasattr(msg, "k") and len(msg.k) == 9 and msg.k[0] > 0:
            K = np.array(msg.k, dtype=np.float32).reshape(3, 3)
            self.camera_matrix = K
            if hasattr(msg, "d") and len(msg.d) > 0:
                self.distortion_coefficients = np.array(msg.d, dtype=np.float32)
            else:
                self.distortion_coefficients = np.zeros(5, dtype=np.float32)

            if self.grasp_center_2d is None or self.grasp_center_3d_cam is None:
                self._init_tcp_reticle_projection()

            if not self.swept_volume_data:
                self._init_swept_volume_model(max_open=self.max_open)
        else:
            self.get_logger().warning(
                "::_camera_info_cb: Received invalid camera_info message; ignoring."
            )

    def _init_tcp_reticle_projection(self) -> None:
        """
        Calculate the 2D projected pixel location and radius of the TCP reticle.

        Args:
            None.

        Returns:
            None.
        """
        if self.camera_matrix is None or self.camera_matrix[0, 0] <= 0:
            self.get_logger().warning(
                "::_init_tcp_reticle_projection: Camera matrix not available; cannot compute TCP reticle projection."
            )
            return

        grasp_center_3d, _ = self._compute_3d_grasp_center()
        if grasp_center_3d is not None:
            self.grasp_center_3d_cam = grasp_center_3d.ravel()
            u, v = project_point_to_pixel(
                self.grasp_center_3d_cam,
                self.camera_matrix,
                self.distortion_coefficients,
            )
            self.grasp_center_2d = (u, v)

            fx = float(self.camera_matrix[0, 0])
            z_tcp = float(self.grasp_center_3d_cam[2])
            self.grasp_center_radius_px = compute_reticle_pixel_radius(
                fx=fx,
                z_tcp=z_tcp,
                reticle_radius_m=RETICLE_RADIUS_M,
                default_radius_px=9.0,
            )

    def _compute_3d_grasp_center(self) -> tuple[np.ndarray | None, str]:
        """
        Compute 3D position of the tool grasp center in the camera frame.

        Args:
            None.

        Returns:
            A tuple containing the (3,) numpy array position (or None) and a source description string.
        """
        grasp_center_3d = None
        source_desc = ""

        if FingertipVisualizer is not None and cu is not None:
            model_path = cu.get_default_model_path()
            if model_path and os.path.exists(model_path):
                try:
                    vis_model = FingertipVisualizer(model_path)
                    pos_l, _ = vis_model.predict("left", 0.0)
                    pos_r, _ = vis_model.predict("right", 0.0)
                    if pos_l is not None and pos_r is not None:
                        grasp_center_3d = (pos_l + pos_r) / 2.0
                        source_desc = (
                            f"FingertipVisualizer ('{os.path.basename(model_path)}')"
                        )
                except Exception as err:
                    self.get_logger().warning(
                        f"Failed computing grasp center with FingertipVisualizer: {err}"
                    )

        if grasp_center_3d is None:
            try:
                if get_urdf_from_robot_params is not None and get_transform is not None:
                    urdf_str = get_urdf_from_robot_params()
                    frame_name = "gripper_right_camera_color_optical_frame"
                    T = get_transform(
                        urdf_str, frame_to="grasp_center_link", frame_from=frame_name
                    )
                    grasp_center_3d = T[:3, 3].astype(np.float32)
                    source_desc = "Stretch 4 URDF Kinematics (grasp_center_link)"
            except Exception as err:
                self.get_logger().warning(
                    f"Failed computing grasp center from URDF: {err}"
                )

        if grasp_center_3d is None:
            grasp_center_3d = np.array([0.0, 0.0, DEFAULT_TCP_Z], dtype=np.float32)
            source_desc = (
                f"Default Stretch 4 Gripper Baseline Offset (Z={DEFAULT_TCP_Z:.3f}m)"
            )

        return grasp_center_3d, source_desc

    def _init_swept_volume_model(self, max_open: float = MAX_OPEN_PCT) -> None:
        """
        Initialize swept volume geometry models and project trajectory rings to 2D.

        Args:
            max_open: Gripper opening percentage defining trajectory start.

        Returns:
            None.
        """
        if self.camera_matrix is None or self.camera_matrix[0, 0] <= 0:
            return

        self.swept_volume_data = []

        if FingertipVisualizer is None or SweptVolumeModel is None or cu is None:
            self.get_logger().warning(
                "SweptVolumeModel or FingertipVisualizer not available."
            )
            return

        model_path = cu.get_default_model_path()
        if not model_path or not os.path.exists(model_path):
            self.get_logger().warning(
                "Compliant gripper model path not found for swept volume."
            )
            return

        try:
            vis_model = FingertipVisualizer(model_path)

            for side in ["left", "right"]:
                sv_model = SweptVolumeModel(
                    kinematic_model=vis_model,
                    side=side,
                    start_cfg=max_open,
                    end_cfg=0.0,
                )
                if not sv_model.valid:
                    continue

                pcts = sv_model.get_sampled_pcts(
                    sampling_method="pos_pct", num_samples=30
                )
                side_rings_2d: list[np.ndarray] = []
                side_rings_3d: list[np.ndarray] = []
                z_depths: list[float] = []

                for pct in pcts:
                    pts_3d = sv_model.get_circle_points(pct, num_points=16)
                    pos, _ = sv_model.get_frame(pct)
                    if pts_3d is not None and pos is not None:
                        pts_3d_np = np.array(pts_3d, dtype=np.float32)
                        pts_2d = project_points_to_pixels(
                            pts_3d_np,
                            self.camera_matrix,
                            self.distortion_coefficients,
                        )
                        pts_2d_int = np.round(pts_2d).astype(np.int32)
                        side_rings_2d.append(pts_2d_int)
                        side_rings_3d.append(pts_3d_np)
                        z_depths.extend(pts_3d_np[:, 2].tolist())

                if side_rings_2d:
                    z_min = float(np.min(z_depths))
                    z_max = float(np.max(z_depths))
                    self.swept_volume_data.append(
                        {
                            "side": side,
                            "rings_2d": side_rings_2d,
                            "rings_3d": side_rings_3d,
                            "z_min": z_min,
                            "z_max": z_max,
                        }
                    )

            if self.swept_volume_data:
                self.grasp_z_max = (
                    max(d["z_max"] for d in self.swept_volume_data) + 0.01
                )
        except Exception as err:
            self.get_logger().warning(f"Error initializing swept volume models: {err}")

    def _rgb_cb(self, msg: CompressedImage) -> None:
        """
        Store incoming compressed RGB camera frame in buffer.

        Args:
            msg: CompressedImage ROS message containing RGB data.

        Returns:
            None.
        """
        with self.image_lock:
            self.latest_rgb_msg = msg

    def _depth_cb(self, msg: CompressedImage) -> None:
        """
        Decode and buffer incoming compressed depth image into floating-point meters.

        Args:
            msg: CompressedImage ROS message containing depth data.

        Returns:
            None.
        """
        try:
            depth_raw = ros_msg_to_cv2_image(msg)
            if depth_raw is not None and depth_raw.size > 0:
                if depth_raw.dtype == np.uint16 or np.nanmax(depth_raw) > 50.0:
                    depth_m = depth_raw.astype(np.float32) / 1000.0
                else:
                    depth_m = depth_raw.astype(np.float32)
                with self.image_lock:
                    self.cached_depth_img = depth_m
        except Exception as err:
            self.get_logger().warning(f"Error decoding depth ROS message: {err}")

    def _toggle_swept_volume_cb(
        self, req: Trigger.Request, res: Trigger.Response
    ) -> Trigger.Response:
        """
        Toggle rendering of the compliant fingertip swept volume manifold.

        Args:
            req: Empty trigger request.
            res: Trigger response indicating success and new toggle state.

        Returns:
            Populated Trigger.Response object.
        """
        self.show_swept_volume = not self.show_swept_volume
        res.success = True
        res.message = f"Swept volume overlay {'enabled' if self.show_swept_volume else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _toggle_depth_heatmap_cb(
        self, req: Trigger.Request, res: Trigger.Response
    ) -> Trigger.Response:
        """
        Toggle rendering of the RGB-D surface point depth heatmap.

        Args:
            req: Empty trigger request.
            res: Trigger response indicating success and new toggle state.

        Returns:
            Populated Trigger.Response object.
        """
        self.show_depth_points = not self.show_depth_points
        res.success = True
        res.message = f"Depth heatmap overlay {'enabled' if self.show_depth_points else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _toggle_reticle_cb(
        self, req: Trigger.Request, res: Trigger.Response
    ) -> Trigger.Response:
        """
        Toggle rendering of the TCP crosshair reticle.

        Args:
            req: Empty trigger request.
            res: Trigger response indicating success and new toggle state.

        Returns:
            Populated Trigger.Response object.
        """
        self.show_reticle = not self.show_reticle
        res.success = True
        res.message = (
            f"Reticle crosshair {'enabled' if self.show_reticle else 'disabled'}."
        )
        self.get_logger().info(res.message)
        return res

    def _enable_processing_cb(
        self, req: SetBool.Request, res: SetBool.Response
    ) -> SetBool.Response:
        """
        Enable or disable perception overlay processing loop.

        Args:
            req: SetBool request containing enable boolean flag in data field.
            res: SetBool response indicating success and new status message.

        Returns:
            Populated SetBool.Response object.
        """
        self.processing_enabled = req.data
        res.success = True
        res.message = f"Perception processing {'enabled' if self.processing_enabled else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _get_reticle_window_mask(self, vis_w: int, vis_h: int) -> np.ndarray:
        """
        Compute the 2D boolean mask for the reticle depth evaluation window.

        Args:
            vis_w: Image width in pixels.
            vis_h: Image height in pixels.

        Returns:
            A boolean mask of shape (vis_h, vis_w) indicating the window region.
        """
        if self.camera_matrix is None or self.camera_matrix[0, 0] <= 0:
            return np.zeros((vis_h, vis_w), dtype=bool)

        fx = float(self.camera_matrix[0, 0])
        z_tcp = (
            float(self.grasp_center_3d_cam[2])
            if self.grasp_center_3d_cam is not None
            else DEFAULT_TCP_Z
        )

        return compute_reticle_window_mask(
            vis_w=vis_w,
            vis_h=vis_h,
            grasp_center_2d=self.grasp_center_2d,
            fx=fx,
            z_tcp=z_tcp,
            grasp_center_radius_px=self.grasp_center_radius_px,
            window_half_width_m=WINDOW_HALF_WIDTH_M,
        )

    def _update_reticle_depth_window(
        self, depth_img: np.ndarray | None, vis_w: int, vis_h: int
    ) -> None:
        """
        Update point counts and classify reticle state from the latest depth image.

        Args:
            depth_img: Single-channel depth image in meters, or None.
            vis_w: Image width in pixels.
            vis_h: Image height in pixels.

        Returns:
            None.
        """
        if depth_img is None or depth_img.size == 0:
            return

        window_mask = self._get_reticle_window_mask(vis_w, vis_h)

        if self.swept_volume_data:
            sv_mask = (
                compute_swept_volume_mask(vis_w, vis_h, self.swept_volume_data) > 0
            )
            counting_mask = window_mask & sv_mask
        else:
            counting_mask = window_mask

        z_max = getattr(self, "grasp_z_max", GRASP_Z_MAX_DEFAULT)
        state, num_pts, num_near = evaluate_reticle_depth_state(
            depth_m=depth_img,
            counting_mask=counting_mask,
            z_max=z_max,
            z_near_m=Z_NEAR_M,
            min_yellow=N_POINTS_MIN_YELLOW,
            min_green=N_POINTS_MIN_GREEN,
        )
        self.reticle_state = state
        self.num_window_pts = num_pts
        self.num_near_window_pts = num_near

    def _draw_swept_volume_overlay(
        self, vis_frame: np.ndarray, depth_img: np.ndarray | None
    ) -> np.ndarray:
        """
        Render swept volume manifold and depth heatmap overlays onto the frame.

        Args:
            vis_frame: Input BGR image array.
            depth_img: Single-channel depth image in meters, or None.

        Returns:
            Annotated BGR image array.
        """
        vis_h, vis_w = vis_frame.shape[:2]
        self._update_reticle_depth_window(depth_img, vis_w, vis_h)

        combined_mask_2d = np.zeros((vis_h, vis_w), dtype=np.uint8)

        if self.swept_volume_data:
            rendered_frame, combined_mask_2d = render_swept_volume_manifold(
                vis_frame=vis_frame,
                swept_volume_data=self.swept_volume_data,
            )
            if self.show_swept_volume:
                vis_frame = rendered_frame

        if depth_img is not None and depth_img.size > 0 and self.show_depth_points:
            if np.any(combined_mask_2d > 0):
                valid_mask = combined_mask_2d > 0
            else:
                valid_mask = self._get_reticle_window_mask(vis_w, vis_h)

            z_max = getattr(self, "grasp_z_max", GRASP_Z_MAX_DEFAULT)
            vis_frame = render_depth_heatmap_overlay(
                vis_frame=vis_frame,
                depth_img=depth_img,
                valid_mask=valid_mask,
                z_max=z_max,
                z_min_bound=0.10,
                alpha=0.50,
            )

        return vis_frame

    def _draw_reticle_overlay(self, vis_frame: np.ndarray) -> np.ndarray:
        """
        Render the crosshair reticle overlay onto the frame if enabled.

        Args:
            vis_frame: Input BGR image array.

        Returns:
            Annotated BGR image array.
        """
        if not self.show_reticle:
            return vis_frame

        if self.grasp_center_2d is None:
            self._init_tcp_reticle_projection()

        if self.grasp_center_2d is None:
            return vis_frame

        return draw_reticle_overlay(
            vis_frame=vis_frame,
            grasp_center_2d=self.grasp_center_2d,
            radius_px=self.grasp_center_radius_px,
            state=self.reticle_state,
            tick_length=10,
        )

    def _process_loop(self) -> None:
        """
        Execute periodic perception cycle at timer frequency.

        Processes latest RGB and depth frames, applies visual overlays,
        and publishes reticle state along with raw and compressed images.

        Args:
            None.

        Returns:
            None.
        """
        if not self.processing_enabled:
            return

        with self.image_lock:
            rgb_msg = self.latest_rgb_msg
            depth_img = self.cached_depth_img

        if rgb_msg is None:
            return

        try:
            image_bgr = ros_msg_to_cv2_image(rgb_msg)
        except Exception as err:
            self.get_logger().warning(f"Error decoding image ROS message: {err}")
            return

        if image_bgr is None or image_bgr.size == 0:
            return

        # Process frame and draw overlays
        vis_frame = self._draw_swept_volume_overlay(image_bgr.copy(), depth_img)
        vis_frame = self._draw_reticle_overlay(vis_frame)

        # Publish reticle enum state
        state_msg = Int8()
        state_msg.data = int(self.reticle_state)
        self.pub_reticle_state.publish(state_msg)

        # Publish raw annotated image (for RViz2)
        raw_msg = cv2_image_to_ros_msg(vis_frame, compress=False)
        raw_msg.header = rgb_msg.header
        self.pub_annotated_raw.publish(raw_msg)

        # Publish compressed annotated image (for web frontend)
        annotated_msg = cv2_image_to_ros_msg(vis_frame, compress=True)
        annotated_msg.header = rgb_msg.header
        self.pub_annotated_img.publish(annotated_msg)


def main(args: list[str] | None = None) -> None:
    """
    Initialize ROS 2 client library and execute GraspingPerceptionNode.

    Args:
        args: Optional command line arguments passed to rclpy initialization.

    Returns:
        None.
    """
    rclpy.init(args=args)
    node = GraspingPerceptionNode()
    executor = MultiThreadedExecutor(num_threads=4)
    try:
        rclpy.spin(node, executor=executor)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
