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

import glob
import os
import sys
import threading
from typing import Any, Optional, Tuple

import cv2
import numpy as np
import yaml

import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CameraInfo, CompressedImage
from std_msgs.msg import Int8
from std_srvs.srv import SetBool, Trigger

from stretch4_urdf import get_transform, get_urdf_from_robot_params

from stretch4_web_teleop_helpers.conversions import (
    cv2_image_to_ros_msg,
    ros_msg_to_cv2_image,
)

# Import compliant gripper modeling utilities
gripper_pkg_dir = os.path.join(os.path.expanduser("~"), "repos/stretch4_compliant_gripper/src")
if gripper_pkg_dir not in sys.path:
    sys.path.insert(0, gripper_pkg_dir)

try:
    from stretch4_gripper_modeling_and_control import calibration_utils as cu
    from stretch4_gripper_modeling_and_control.fingertip_visualizer import FingertipVisualizer
    from stretch4_gripper_modeling_and_control.swept_volume_model import SweptVolumeModel
except ImportError:
    cu = None
    FingertipVisualizer = None
    SweptVolumeModel = None

# ==============================================================================
# PERCEPTION & THRESHOLD CONSTANTS
# ==============================================================================
N_POINTS_MIN_YELLOW = 100        # Minimum points in window for YELLOW state
N_POINTS_MIN_GREEN = 1000        # Minimum points in window for GREEN state
Z_NEAR_M = 0.20                  # Near point distance threshold in meters
WINDOW_HALF_WIDTH_M = 0.02       # Half-width of 4cm window (0.02m = 2cm)
RETICLE_RADIUS_M = 0.005         # Physical radius corresponding to 1cm circle (0.5cm = 0.005m)
GRASP_Z_MAX_DEFAULT = 0.259      # Default Z max depth bound (meters)
MAX_OPEN_PCT = 280.0             # Maximum physical gripper opening percentage
DEFAULT_TCP_Z = 0.216            # Default baseline TCP Z offset (meters)
STATE_RED = 0                    # Reticle state 0: RED
STATE_YELLOW = 1                 # Reticle state 1: YELLOW
STATE_GREEN = 2                  # Reticle state 2: GREEN
# ==============================================================================


class GraspingPerceptionNode(Node):
    """
    ROS 2 Node handling real-time grasping perception data processing and overlay emission.
    """

    def __init__(self) -> None:
        super().__init__("grasping_perception_node")

        self.get_logger().info("Initializing Grasping Perception Node...")

        # Feature toggle states
        self.processing_enabled = True
        self.show_swept_volume = True
        self.show_depth_points = False
        self.show_reticle = True
        self.max_open = MAX_OPEN_PCT

        # State locks and image buffers
        self.image_lock = threading.Lock()
        self.latest_rgb_msg: Optional[CompressedImage] = None
        self.cached_depth_img: Optional[np.ndarray] = None

        # Camera calibration intrinsics
        self.camera_matrix, self.distortion_coefficients = self._init_camera_intrinsics()

        # Tool Grasp Center Point (TCP) projection
        self.grasp_center_2d: Optional[Tuple[float, float]] = None
        self.grasp_center_3d_cam: Optional[np.ndarray] = None
        self.grasp_center_radius_px: float = 9.0
        self._init_tcp_reticle_projection()

        # Pre-compute compliant fingertip swept volume trajectory geometry
        self.swept_volume_data: list[dict[str, Any]] = []
        self.grasp_z_max: float = GRASP_Z_MAX_DEFAULT
        self._init_swept_volume_model(max_open=self.max_open)

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
        self.pub_reticle_state = self.create_publisher(Int8, "/grasping_perception/reticle_state", 10)
        self.pub_annotated_img = self.create_publisher(
            CompressedImage, "/grasping_perception/annotated_image/compressed", 10
        )

        # Services
        self.srv_toggle_sv = self.create_service(
            Trigger, "/grasping_perception/toggle_swept_volume", self._toggle_swept_volume_cb
        )
        self.srv_toggle_depth = self.create_service(
            Trigger, "/grasping_perception/toggle_depth_heatmap", self._toggle_depth_heatmap_cb
        )
        self.srv_toggle_reticle = self.create_service(
            Trigger, "/grasping_perception/toggle_reticle", self._toggle_reticle_cb
        )
        self.srv_enable_processing = self.create_service(
            SetBool, "/grasping_perception/enable_processing", self._enable_processing_cb
        )

        # Main processing timer (15 Hz)
        self.timer = self.create_timer(1.0 / 15.0, self._process_loop)

        self.get_logger().info("Grasping Perception Node fully initialized and running.")

    def _init_camera_intrinsics(self) -> Tuple[np.ndarray, np.ndarray]:
        K = None
        dist_coeffs = np.zeros(5, dtype=np.float32)

        model_path = cu.get_default_model_path() if cu is not None else None
        if model_path and os.path.exists(model_path):
            try:
                with open(model_path, "r") as f:
                    model_data = yaml.safe_load(f)
                calib_dir = os.path.dirname(os.path.abspath(model_path))
                yaml_files = glob.glob(os.path.join(calib_dir, "*_gripper_data_*.yaml"))
                if yaml_files:
                    with open(yaml_files[0], "r") as f:
                        data = yaml.safe_load(f)
                        meta = data.get("metadata", {})
                        if "camera_matrix" in meta:
                            raw_K = np.array(meta["camera_matrix"], dtype=np.float32)
                            res = meta.get("image_resolution", [1280, 800])
                            scale = 640.0 / float(res[0])
                            K = raw_K.copy()
                            K[0, 0] *= scale
                            K[1, 1] *= scale
                            K[0, 2] *= scale
                            K[1, 2] *= scale
                            if "distortion_coefficients" in meta:
                                dist_coeffs = np.array(meta["distortion_coefficients"], dtype=np.float32)
                            self.get_logger().info(f"Loaded camera matrix from calibration dataset: {yaml_files[0]}")
            except Exception as err:
                self.get_logger().warning(f"Failed loading camera intrinsics from YAML: {err}")

        if K is None:
            self.get_logger().info("Using default OAK-D SR 640x400 camera matrix.")
            K = np.array(
                [
                    [397.78253, 0.0, 315.42755],
                    [0.0, 397.70575, 209.46078],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float32,
            )

        return K.astype(np.float32), dist_coeffs.astype(np.float32)

    def _camera_info_cb(self, msg: CameraInfo) -> None:
        if hasattr(msg, "k") and len(msg.k) == 9 and msg.k[0] > 0:
            K = np.array(msg.k, dtype=np.float32).reshape(3, 3)
            self.camera_matrix = K
            if hasattr(msg, "d") and len(msg.d) >= 5:
                self.distortion_coefficients = np.array(msg.d[:5], dtype=np.float32)
            self._init_tcp_reticle_projection()

    def _init_tcp_reticle_projection(self) -> None:
        grasp_center_3d, source_desc = self._compute_3d_grasp_center()
        if grasp_center_3d is not None:
            self.grasp_center_3d_cam = grasp_center_3d.ravel()
            P_3d = grasp_center_3d.reshape(1, 1, 3).astype(np.float32)
            rvec = np.zeros((3, 1), dtype=np.float32)
            tvec = np.zeros((3, 1), dtype=np.float32)

            pts_2d, _ = cv2.projectPoints(P_3d, rvec, tvec, self.camera_matrix, self.distortion_coefficients)
            u, v = pts_2d.ravel()
            self.grasp_center_2d = (float(u), float(v))

            fx = float(self.camera_matrix[0, 0])
            z_tcp = float(self.grasp_center_3d_cam[2])
            if z_tcp > 0:
                self.grasp_center_radius_px = (fx * RETICLE_RADIUS_M) / z_tcp
            else:
                self.grasp_center_radius_px = 9.0

            # self.get_logger().info(f"TCP Source: {source_desc}")
            # self.get_logger().info(f"2D TCP Reticle: u={u:.1f}px, v={v:.1f}px (radius={self.grasp_center_radius_px:.2f}px)")

    def _compute_3d_grasp_center(self) -> Tuple[Optional[np.ndarray], str]:
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
                        source_desc = f"FingertipVisualizer ('{os.path.basename(model_path)}')"
                except Exception as err:
                    self.get_logger().warning(f"Failed computing grasp center with FingertipVisualizer: {err}")

        if grasp_center_3d is None:
            try:
                if get_urdf_from_robot_params is not None and get_transform is not None:
                    urdf_str = get_urdf_from_robot_params()
                    frame_name = "gripper_right_camera_color_optical_frame"
                    T = get_transform(urdf_str, frame_to="grasp_center_link", frame_from=frame_name)
                    grasp_center_3d = T[:3, 3].astype(np.float32)
                    source_desc = "Stretch 4 URDF Kinematics (grasp_center_link)"
            except Exception as err:
                self.get_logger().warning(f"Failed computing grasp center from URDF: {err}")

        if grasp_center_3d is None:
            grasp_center_3d = np.array([0.0, 0.0, DEFAULT_TCP_Z], dtype=np.float32)
            source_desc = f"Default Stretch 4 Gripper Baseline Offset (Z={DEFAULT_TCP_Z:.3f}m)"

        return grasp_center_3d, source_desc

    def _init_swept_volume_model(self, max_open: float = MAX_OPEN_PCT) -> None:
        self.swept_volume_data = []

        if FingertipVisualizer is None or SweptVolumeModel is None or cu is None:
            self.get_logger().warning("SweptVolumeModel or FingertipVisualizer not available.")
            return

        model_path = cu.get_default_model_path()
        if not model_path or not os.path.exists(model_path):
            self.get_logger().warning("Compliant gripper model path not found for swept volume.")
            return

        try:
            vis_model = FingertipVisualizer(model_path)
            rvec = np.zeros((3, 1), dtype=np.float32)
            tvec = np.zeros((3, 1), dtype=np.float32)

            for side in ["left", "right"]:
                sv_model = SweptVolumeModel(
                    kinematic_model=vis_model,
                    side=side,
                    start_cfg=max_open,
                    end_cfg=0.0,
                )
                if not sv_model.valid:
                    continue

                pcts = sv_model.get_sampled_pcts(sampling_method="pos_pct", num_samples=30)
                side_rings_2d: list[np.ndarray] = []
                side_rings_3d: list[np.ndarray] = []
                z_depths: list[float] = []

                for pct in pcts:
                    pts_3d = sv_model.get_circle_points(pct, num_points=16)
                    pos, _ = sv_model.get_frame(pct)
                    if pts_3d is not None and pos is not None:
                        pts_3d_np = np.array(pts_3d, dtype=np.float32)
                        pts_2d, _ = cv2.projectPoints(
                            pts_3d_np.reshape(-1, 1, 3),
                            rvec,
                            tvec,
                            self.camera_matrix,
                            self.distortion_coefficients,
                        )
                        pts_2d_int = np.round(pts_2d.reshape(-1, 2)).astype(np.int32)
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
                self.grasp_z_max = max(d["z_max"] for d in self.swept_volume_data) + 0.01
                self.get_logger().info(f"Pre-computed swept volume manifold (Z_max={self.grasp_z_max:.3f}m).")
        except Exception as err:
            self.get_logger().warning(f"Error initializing swept volume models: {err}")

    def _rgb_cb(self, msg: CompressedImage) -> None:
        with self.image_lock:
            self.latest_rgb_msg = msg

    def _depth_cb(self, msg: CompressedImage) -> None:
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

    def _toggle_swept_volume_cb(self, req: Trigger.Request, res: Trigger.Response) -> Trigger.Response:
        self.show_swept_volume = not self.show_swept_volume
        res.success = True
        res.message = f"Swept volume overlay {'enabled' if self.show_swept_volume else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _toggle_depth_heatmap_cb(self, req: Trigger.Request, res: Trigger.Response) -> Trigger.Response:
        self.show_depth_points = not self.show_depth_points
        res.success = True
        res.message = f"Depth heatmap overlay {'enabled' if self.show_depth_points else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _toggle_reticle_cb(self, req: Trigger.Request, res: Trigger.Response) -> Trigger.Response:
        self.show_reticle = not self.show_reticle
        res.success = True
        res.message = f"Reticle crosshair {'enabled' if self.show_reticle else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _enable_processing_cb(self, req: SetBool.Request, res: SetBool.Response) -> SetBool.Response:
        self.processing_enabled = req.data
        res.success = True
        res.message = f"Perception processing {'enabled' if self.processing_enabled else 'disabled'}."
        self.get_logger().info(res.message)
        return res

    def _get_reticle_window_mask(self, vis_w: int, vis_h: int) -> np.ndarray:
        u_reticle = self.grasp_center_2d[0] if self.grasp_center_2d is not None else (vis_w / 2.0)
        v_reticle = self.grasp_center_2d[1] if self.grasp_center_2d is not None else (vis_h / 2.0)
        fx = float(self.camera_matrix[0, 0])
        z_tcp = float(self.grasp_center_3d_cam[2]) if self.grasp_center_3d_cam is not None else DEFAULT_TCP_Z
        w_half_px = (fx * WINDOW_HALF_WIDTH_M) / z_tcp if z_tcp > 0 else 37.0
        r_px = float(self.grasp_center_radius_px)

        u_min = max(0, int(round(u_reticle - w_half_px)))
        u_max = min(vis_w, int(round(u_reticle + w_half_px)))
        v_bottom = max(0, min(vis_h, int(round(v_reticle + r_px))))

        window_mask = np.zeros((vis_h, vis_w), dtype=bool)
        window_mask[:v_bottom, u_min:u_max] = True
        return window_mask

    def _update_reticle_depth_window(self, depth_img: Optional[np.ndarray], vis_w: int, vis_h: int) -> None:
        if depth_img is None or depth_img.size == 0:
            return

        depth_m = depth_img

        window_mask = self._get_reticle_window_mask(vis_w, vis_h)

        if self.swept_volume_data:
            sv_mask_u8 = np.zeros((vis_h, vis_w), dtype=np.uint8)
            for finger_data in self.swept_volume_data:
                rings_2d = finger_data["rings_2d"]
                prev_ring = None
                for pts_2d in rings_2d:
                    if prev_ring is not None:
                        quad_pts = np.vstack((prev_ring, pts_2d))
                        hull = cv2.convexHull(quad_pts)
                        cv2.fillPoly(sv_mask_u8, [hull], 255)
                    prev_ring = pts_2d
            sv_mask = (sv_mask_u8 > 0)
            counting_mask = window_mask & sv_mask
        else:
            counting_mask = window_mask

        z_max = getattr(self, "grasp_z_max", GRASP_Z_MAX_DEFAULT)
        depth_in_range = (depth_m > 0.01) & (depth_m <= z_max)
        graspable_in_mask = depth_in_range & counting_mask
        self.num_window_pts = int(np.count_nonzero(graspable_in_mask))

        near_in_mask = graspable_in_mask & (depth_m <= Z_NEAR_M)
        self.num_near_window_pts = int(np.count_nonzero(near_in_mask))

        # Determine reticle enum state
        if self.num_window_pts > N_POINTS_MIN_GREEN and self.num_near_window_pts > 0:
            self.reticle_state = STATE_GREEN
        elif N_POINTS_MIN_YELLOW <= self.num_window_pts <= N_POINTS_MIN_GREEN or (
            self.num_window_pts > N_POINTS_MIN_GREEN and self.num_near_window_pts == 0
        ):
            self.reticle_state = STATE_YELLOW
        else:
            self.reticle_state = STATE_RED

    def _draw_swept_volume_overlay(self, vis_frame: np.ndarray, depth_img: Optional[np.ndarray]) -> np.ndarray:
        vis_h, vis_w = vis_frame.shape[:2]
        self._update_reticle_depth_window(depth_img, vis_w, vis_h)

        combined_mask_2d = np.zeros((vis_h, vis_w), dtype=np.uint8)

        if self.show_swept_volume and self.swept_volume_data:
            vol_overlay = vis_frame.copy()
            wire_overlay = vis_frame.copy()
            manifold_color = (128, 128, 128)

            for finger_data in self.swept_volume_data:
                rings_2d = finger_data["rings_2d"]
                prev_ring = None
                for pts_2d in rings_2d:
                    if prev_ring is not None:
                        quad_pts = np.vstack((prev_ring, pts_2d))
                        hull = cv2.convexHull(quad_pts)
                        cv2.fillPoly(vol_overlay, [hull], manifold_color)
                        cv2.fillPoly(combined_mask_2d, [hull], 255)
                    prev_ring = pts_2d

                wire_color = (180, 180, 180)
                for pts_2d in rings_2d:
                    cv2.polylines(
                        wire_overlay, [pts_2d], isClosed=True, color=wire_color, thickness=1, lineType=cv2.LINE_AA
                    )

            vis_frame = cv2.addWeighted(vol_overlay, 0.20, vis_frame, 0.80, 0)
            vis_frame = cv2.addWeighted(wire_overlay, 0.50, vis_frame, 0.50, 0)

        if depth_img is not None and depth_img.size > 0 and self.show_depth_points:
            highlight_overlay = vis_frame.copy()
            depth_m = depth_img
            z_max = getattr(self, "grasp_z_max", GRASP_Z_MAX_DEFAULT)

            if self.swept_volume_data:
                valid_mask = (combined_mask_2d > 0)
            else:
                valid_mask = self._get_reticle_window_mask(vis_w, vis_h)

            graspable_mask = valid_mask & (depth_m > 0.01) & (depth_m <= z_max)
            if np.any(graspable_mask):
                z_min_bound = 0.10
                z_max_bound = max(z_max, z_min_bound + 0.01)
                depth_norm = np.clip((depth_m - z_min_bound) / (z_max_bound - z_min_bound), 0.0, 1.0)
                depth_u8 = np.clip((1.0 - depth_norm) * 255.0, 0, 255).astype(np.uint8)
                jet_color_map = cv2.applyColorMap(depth_u8, cv2.COLORMAP_JET)
                highlight_overlay[graspable_mask] = jet_color_map[graspable_mask]
                vis_frame = cv2.addWeighted(highlight_overlay, 0.50, vis_frame, 0.50, 0)

        return vis_frame

    def _draw_reticle_overlay(self, vis_frame: np.ndarray) -> np.ndarray:
        if not self.show_reticle or self.grasp_center_2d is None:
            return vis_frame

        u_vis, v_vis = int(self.grasp_center_2d[0]), int(self.grasp_center_2d[1])
        r_vis = max(2, int(self.grasp_center_radius_px))
        tick_len = 10

        if self.reticle_state == STATE_GREEN:
            reticle_color = (0, 255, 0)      # GREEN
        elif self.reticle_state == STATE_YELLOW:
            reticle_color = (0, 255, 255)    # YELLOW
        else:
            reticle_color = (0, 0, 255)      # RED

        # Draw black outline background
        cv2.circle(vis_frame, (u_vis, v_vis), r_vis, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis - r_vis - tick_len, v_vis), (u_vis - r_vis, v_vis), (0, 0, 0), 3, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis + r_vis, v_vis), (u_vis + r_vis + tick_len, v_vis), (0, 0, 0), 3, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis, v_vis - r_vis - tick_len), (u_vis, v_vis - r_vis), (0, 0, 0), 3, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis, v_vis + r_vis), (u_vis, v_vis + r_vis + tick_len), (0, 0, 0), 3, cv2.LINE_AA)

        # Draw dynamic reticle foreground
        cv2.circle(vis_frame, (u_vis, v_vis), r_vis, reticle_color, 2, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis - r_vis - tick_len, v_vis), (u_vis - r_vis, v_vis), reticle_color, 2, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis + r_vis, v_vis), (u_vis + r_vis + tick_len, v_vis), reticle_color, 2, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis, v_vis - r_vis - tick_len), (u_vis, v_vis - r_vis), reticle_color, 2, cv2.LINE_AA)
        cv2.line(vis_frame, (u_vis, v_vis + r_vis), (u_vis, v_vis + r_vis + tick_len), reticle_color, 2, cv2.LINE_AA)

        return vis_frame

    def _process_loop(self) -> None:
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

        # Publish annotated image
        annotated_msg = cv2_image_to_ros_msg(vis_frame, compress=True)
        annotated_msg.header = rgb_msg.header
        self.pub_annotated_img.publish(annotated_msg)


def main(args: Optional[list[str]] = None) -> None:
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
