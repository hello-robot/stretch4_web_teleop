#!/usr/bin/env python3
"""
Pure Python image manipulation and overlay utilities for grasping perception.

Provides modular computer vision primitives and rendering routines for:
1. Tool Center Point (TCP) crosshair reticle with dynamic color states.
2. Compliant fingertip swept volume manifold rendering and mask computation.
3. RGB-D surface point depth heatmaps (JET colormap).
4. Spatial evaluation masks and grasp readiness classification.
5. Artificial horizon line overlay aligned with wrist roll and pitch.
6. Schematic robot state telemetry icon in viewport corner.
"""

from typing import Any

import cv2
import numpy as np

# ==============================================================================
# PERCEPTION & THRESHOLD CONSTANTS
# ==============================================================================
COLOR_BLACK: tuple[int, int, int] = (0, 0, 0)
COLOR_GREEN: tuple[int, int, int] = (0, 255, 0)
COLOR_MANIFOLD: tuple[int, int, int] = (128, 128, 128)
COLOR_ORANGE: tuple[int, int, int] = (0, 140, 255)
COLOR_RED: tuple[int, int, int] = (0, 0, 255)
COLOR_WHITE: tuple[int, int, int] = (255, 255, 255)
COLOR_WIREFRAME: tuple[int, int, int] = (180, 180, 180)
COLOR_YELLOW: tuple[int, int, int] = (0, 255, 255)

DEFAULT_ARM_LIMITS: tuple[float, float] = (0.0, 0.52)
DEFAULT_ICON_SCALE: float = 1.0
DEFAULT_KEEPOUT_SLICE_DEG: float = 30.0
DEFAULT_LIFT_LIMITS: tuple[float, float] = (0.0, 1.2)
DEFAULT_PITCH_LIMITS: tuple[float, float] = (-1.135, 4.276)
DEFAULT_ROLL_LIMITS: tuple[float, float] = (-4.276, 1.135)
DEFAULT_TCP_Z: float = 0.216
DEFAULT_YAW_LIMITS: tuple[float, float] = (-1.135, 4.276)

GRASP_Z_MAX_DEFAULT: float = 0.259
N_POINTS_MIN_GREEN: int = 1000
N_POINTS_MIN_YELLOW: int = 100
RETICLE_RADIUS_M: float = 0.005
STATE_GREEN: int = 2
STATE_RED: int = 0
STATE_YELLOW: int = 1
WINDOW_HALF_WIDTH_M: float = 0.02
Z_NEAR_M: float = 0.20


def get_reticle_color(state: int) -> tuple[int, int, int]:
    """
    Get the BGR color representation corresponding to a reticle state.

    Args:
        state: Reticle state identifier (STATE_RED, STATE_YELLOW, or STATE_GREEN).

    Returns:
        A tuple of three integers representing the BGR color.
    """
    if state == STATE_GREEN:
        return COLOR_GREEN
    if state == STATE_YELLOW:
        return COLOR_YELLOW
    return COLOR_RED


def compute_limit_danger_factor(
    val: float,
    val_min: float,
    val_max: float,
    zone_pct: float = 0.10,
) -> float:
    """
    Compute a normalized factor [0.0, 1.0] representing proximity to range limits.

    Returns 0.0 in the middle safe zone, transitioning linearly from 0.0 to 1.0
    in the first and last zone_pct of the range of motion.

    Args:
        val: Current scalar joint position.
        val_min: Minimum joint limit boundary.
        val_max: Maximum joint limit boundary.
        zone_pct: Fraction of total range on each end considered warning zone.

    Returns:
        Normalized danger factor from 0.0 (safe zone) to 1.0 (at or beyond limit).
    """
    if val_max <= val_min:
        return 0.0
    norm = float(np.clip((val - val_min) / (val_max - val_min), 0.0, 1.0))
    if norm < zone_pct:
        return float(np.clip((zone_pct - norm) / zone_pct, 0.0, 1.0))
    if norm > (1.0 - zone_pct):
        return float(np.clip((norm - (1.0 - zone_pct)) / zone_pct, 0.0, 1.0))
    return 0.0


def interpolate_bgr(
    color_a: tuple[int, int, int],
    color_b: tuple[int, int, int],
    t: float,
) -> tuple[int, int, int]:
    """
    Linearly interpolate between two BGR color tuples.

    Args:
        color_a: Starting BGR color tuple corresponding to t = 0.0.
        color_b: Target BGR color tuple corresponding to t = 1.0.
        t: Transition interpolation factor clamped to [0.0, 1.0].

    Returns:
        Interpolated BGR color tuple with integer components.
    """
    factor = float(np.clip(t, 0.0, 1.0))
    b = int(round((1.0 - factor) * color_a[0] + factor * color_b[0]))
    g = int(round((1.0 - factor) * color_a[1] + factor * color_b[1]))
    r = int(round((1.0 - factor) * color_a[2] + factor * color_b[2]))
    return (b, g, r)


def compute_reticle_pixel_radius(
    fx: float,
    z_tcp: float,
    reticle_radius_m: float = RETICLE_RADIUS_M,
    default_radius_px: float = 9.0,
) -> float:
    """
    Compute the projected pixel radius of the reticle at a given depth.

    Args:
        fx: Focal length in pixels along the X-axis.
        z_tcp: Depth distance to the TCP in meters along the camera Z-axis.
        reticle_radius_m: Physical radius of the reticle circle in meters.
        default_radius_px: Fallback radius in pixels if depth is non-positive.

    Returns:
        Projected reticle radius in pixels.
    """
    if z_tcp > 0.0:
        return (fx * reticle_radius_m) / z_tcp
    return default_radius_px


def project_points_to_pixels(
    points_3d: np.ndarray,
    camera_matrix: np.ndarray,
    distortion_coefficients: np.ndarray | None = None,
) -> np.ndarray:
    """
    Project 3D points in the camera frame into 2D pixel coordinates.

    Args:
        points_3d: Array of 3D points of shape (N, 3) or (N, 1, 3).
        camera_matrix: Camera intrinsic matrix of shape (3, 3).
        distortion_coefficients: Distortion coefficients vector of shape (4,), (5,), or (8,).

    Returns:
        Array of projected 2D coordinates of shape (N, 2).
    """
    if distortion_coefficients is None:
        dist = np.zeros(5, dtype=np.float32)
    else:
        dist = distortion_coefficients

    pts_3d = points_3d.reshape(-1, 1, 3).astype(np.float32)
    rvec = np.zeros((3, 1), dtype=np.float32)
    tvec = np.zeros((3, 1), dtype=np.float32)

    pts_2d, _ = cv2.projectPoints(pts_3d, rvec, tvec, camera_matrix, dist)
    return pts_2d.reshape(-1, 2)


def project_point_to_pixel(
    point_3d: np.ndarray,
    camera_matrix: np.ndarray,
    distortion_coefficients: np.ndarray | None = None,
) -> tuple[float, float]:
    """
    Project a single 3D point in the camera frame into 2D pixel coordinates.

    Args:
        point_3d: 3D point array of shape (3,) or (1, 3).
        camera_matrix: Camera intrinsic matrix of shape (3, 3).
        distortion_coefficients: Distortion coefficients vector of shape (4,), (5,), or (8,).

    Returns:
        A tuple (u, v) representing the projected pixel coordinates.
    """
    pts_2d = project_points_to_pixels(point_3d, camera_matrix, distortion_coefficients)
    u, v = pts_2d[0]
    return float(u), float(v)


def draw_crosshair(
    image: np.ndarray,
    center: tuple[int, int],
    radius: int,
    tick_length: int,
    color: tuple[int, int, int],
    thickness: int,
) -> np.ndarray:
    """
    Draw a circular reticle with four cardinal tick lines onto an image.

    Args:
        image: Target BGR image array.
        center: Coordinates (u, v) in pixels for the reticle center.
        radius: Radius in pixels for the central circle.
        tick_length: Length in pixels for each cardinal tick mark.
        color: BGR color tuple for drawing lines and circle.
        thickness: Line and circle thickness in pixels.

    Returns:
        The modified BGR image array with the crosshair drawn.
    """
    u, v = center
    cv2.circle(image, (u, v), radius, color, thickness, cv2.LINE_AA)
    # Left tick
    cv2.line(
        image,
        (u - radius - tick_length, v),
        (u - radius, v),
        color,
        thickness,
        cv2.LINE_AA,
    )
    # Right tick
    cv2.line(
        image,
        (u + radius, v),
        (u + radius + tick_length, v),
        color,
        thickness,
        cv2.LINE_AA,
    )
    # Top tick
    cv2.line(
        image,
        (u, v - radius - tick_length),
        (u, v - radius),
        color,
        thickness,
        cv2.LINE_AA,
    )
    # Bottom tick
    cv2.line(
        image,
        (u, v + radius),
        (u, v + radius + tick_length),
        color,
        thickness,
        cv2.LINE_AA,
    )
    return image


def draw_reticle_overlay(
    vis_frame: np.ndarray,
    grasp_center_2d: tuple[float, float],
    radius_px: float,
    state: int = STATE_RED,
    tick_length: int = 10,
) -> np.ndarray:
    """
    Draw the TCP reticle crosshair overlay with outline and dynamic color state.

    Args:
        vis_frame: Input BGR image array to annotate.
        grasp_center_2d: Coordinates (u, v) of the projected TCP reticle.
        radius_px: Visual radius of the reticle in pixels.
        state: Reticle state enum governing foreground color.
        tick_length: Length in pixels of each cardinal tick line.

    Returns:
        Annotated BGR image array.
    """
    u_vis, v_vis = int(round(grasp_center_2d[0])), int(round(grasp_center_2d[1]))
    r_vis = max(2, int(round(radius_px)))
    center = (u_vis, v_vis)

    reticle_color = get_reticle_color(state)

    # Draw black outline background
    draw_crosshair(
        vis_frame,
        center=center,
        radius=r_vis,
        tick_length=tick_length,
        color=COLOR_BLACK,
        thickness=3,
    )

    # Draw dynamic reticle foreground
    draw_crosshair(
        vis_frame,
        center=center,
        radius=r_vis,
        tick_length=tick_length,
        color=reticle_color,
        thickness=2,
    )

    return vis_frame


def compute_reticle_window_mask(
    vis_w: int,
    vis_h: int,
    grasp_center_2d: tuple[float, float] | None,
    fx: float,
    z_tcp: float,
    grasp_center_radius_px: float,
    window_half_width_m: float = WINDOW_HALF_WIDTH_M,
) -> np.ndarray:
    """
    Compute a 2D boolean mask representing the rectangular reticle evaluation window.

    Args:
        vis_w: Image width in pixels.
        vis_h: Image height in pixels.
        grasp_center_2d: Projected TCP coordinates (u, v) in pixels, or None to center.
        fx: Focal length in pixels along the camera X-axis.
        z_tcp: Depth distance in meters to the TCP.
        grasp_center_radius_px: Projected radius of the reticle circle in pixels.
        window_half_width_m: Physical half-width of the evaluation window in meters.

    Returns:
        Boolean mask of shape (vis_h, vis_w) with True inside the evaluation window.
    """
    u_reticle = grasp_center_2d[0] if grasp_center_2d is not None else (vis_w / 2.0)
    v_reticle = grasp_center_2d[1] if grasp_center_2d is not None else (vis_h / 2.0)

    w_half_px = (fx * window_half_width_m) / z_tcp if z_tcp > 0 else 37.0
    r_px = float(grasp_center_radius_px)

    u_min = max(0, int(round(u_reticle - w_half_px)))
    u_max = min(vis_w, int(round(u_reticle + w_half_px)))
    v_bottom = max(0, min(vis_h, int(round(v_reticle + r_px))))

    window_mask = np.zeros((vis_h, vis_w), dtype=bool)
    window_mask[:v_bottom, u_min:u_max] = True
    return window_mask


def compute_ring_quad_hulls(rings_2d: list[np.ndarray]) -> list[np.ndarray]:
    """
    Compute convex hulls connecting sequential pairs of rings.

    Args:
        rings_2d: List of 2D coordinate arrays representing sequential rings.

    Returns:
        List of 2D convex hull contour arrays connecting each adjacent pair.
    """
    hulls: list[np.ndarray] = []
    prev_ring: np.ndarray | None = None
    for pts_2d in rings_2d:
        if prev_ring is not None:
            quad_pts = np.vstack((prev_ring, pts_2d))
            hull = cv2.convexHull(quad_pts)
            hulls.append(hull)
        prev_ring = pts_2d
    return hulls


def compute_swept_volume_mask(
    vis_w: int,
    vis_h: int,
    swept_volume_data: list[dict[str, Any]],
) -> np.ndarray:
    """
    Compute a 2D binary uint8 mask of the projected swept volume polygons.

    Args:
        vis_w: Image width in pixels.
        vis_h: Image height in pixels.
        swept_volume_data: List of swept volume geometry dictionaries containing rings_2d.

    Returns:
        A uint8 mask of shape (vis_h, vis_w) with 255 where swept volume is projected.
    """
    sv_mask_u8 = np.zeros((vis_h, vis_w), dtype=np.uint8)
    for finger_data in swept_volume_data:
        rings_2d = finger_data.get("rings_2d", [])
        hulls = compute_ring_quad_hulls(rings_2d)
        if hulls:
            cv2.fillPoly(sv_mask_u8, hulls, 255)
    return sv_mask_u8


def evaluate_reticle_depth_state(
    depth_m: np.ndarray,
    counting_mask: np.ndarray,
    z_max: float = GRASP_Z_MAX_DEFAULT,
    z_near_m: float = Z_NEAR_M,
    min_yellow: int = N_POINTS_MIN_YELLOW,
    min_green: int = N_POINTS_MIN_GREEN,
) -> tuple[int, int, int]:
    """
    Evaluate grasp readiness state from depth points in the active evaluation mask.

    Args:
        depth_m: Single-channel depth array in meters.
        counting_mask: 2D boolean mask indicating spatial evaluation region.
        z_max: Maximum depth bound in meters for valid graspable points.
        z_near_m: Near distance threshold in meters for green state qualification.
        min_yellow: Minimum points within window to achieve yellow state.
        min_green: Minimum points within window to qualify for green state.

    Returns:
        A tuple of (reticle_state, num_window_pts, num_near_window_pts).
    """
    depth_in_range = (depth_m > 0.01) & (depth_m <= z_max)
    graspable_in_mask = depth_in_range & counting_mask
    num_window_pts = int(np.count_nonzero(graspable_in_mask))

    near_in_mask = graspable_in_mask & (depth_m <= z_near_m)
    num_near_window_pts = int(np.count_nonzero(near_in_mask))

    if num_window_pts > min_green and num_near_window_pts > 0:
        reticle_state = STATE_GREEN
    elif min_yellow <= num_window_pts <= min_green or (
        num_window_pts > min_green and num_near_window_pts == 0
    ):
        reticle_state = STATE_YELLOW
    else:
        reticle_state = STATE_RED

    return reticle_state, num_window_pts, num_near_window_pts


def render_swept_volume_manifold(
    vis_frame: np.ndarray,
    swept_volume_data: list[dict[str, Any]],
    manifold_color: tuple[int, int, int] = COLOR_MANIFOLD,
    wire_color: tuple[int, int, int] = COLOR_WIREFRAME,
    alpha_manifold: float = 0.20,
    alpha_wire: float = 0.50,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Render translucent swept volume manifold mesh and wireframe outlines.

    Args:
        vis_frame: Input BGR image array.
        swept_volume_data: List of swept volume geometry dictionaries containing rings_2d.
        manifold_color: BGR color tuple for the shaded manifold surfaces.
        wire_color: BGR color tuple for the ring cross-section outlines.
        alpha_manifold: Opacity weight for shaded manifold surfaces.
        alpha_wire: Opacity weight for wireframe ring outlines.

    Returns:
        A tuple of (annotated_bgr_image, combined_mask_2d_uint8).
    """
    vis_h, vis_w = vis_frame.shape[:2]
    combined_mask_2d = np.zeros((vis_h, vis_w), dtype=np.uint8)

    if not swept_volume_data:
        return vis_frame, combined_mask_2d

    vol_overlay = vis_frame.copy()
    wire_overlay = vis_frame.copy()

    for finger_data in swept_volume_data:
        rings_2d = finger_data.get("rings_2d", [])
        hulls = compute_ring_quad_hulls(rings_2d)
        if hulls:
            cv2.fillPoly(vol_overlay, hulls, manifold_color)
            cv2.fillPoly(combined_mask_2d, hulls, 255)

        for pts_2d in rings_2d:
            cv2.polylines(
                wire_overlay,
                [pts_2d],
                isClosed=True,
                color=wire_color,
                thickness=1,
                lineType=cv2.LINE_AA,
            )

    result = cv2.addWeighted(
        vol_overlay, alpha_manifold, vis_frame, 1.0 - alpha_manifold, 0
    )
    result = cv2.addWeighted(wire_overlay, alpha_wire, result, 1.0 - alpha_wire, 0)
    return result, combined_mask_2d


def render_depth_heatmap_overlay(
    vis_frame: np.ndarray,
    depth_img: np.ndarray,
    valid_mask: np.ndarray,
    z_max: float = GRASP_Z_MAX_DEFAULT,
    z_min_bound: float = 0.10,
    alpha: float = 0.50,
) -> np.ndarray:
    """
    Render a depth point heatmap using JET colormap onto masked image regions.

    Args:
        vis_frame: Input BGR image array.
        depth_img: Single-channel depth image in meters.
        valid_mask: 2D boolean mask indicating regions eligible for heatmap display.
        z_max: Maximum depth bound in meters for graspable points.
        z_min_bound: Lower depth bound in meters for colormap scaling.
        alpha: Blending weight for the heatmap overlay.

    Returns:
        Annotated BGR image array with depth heatmap blended.
    """
    if depth_img is None or depth_img.size == 0:
        return vis_frame

    depth_m = depth_img
    graspable_mask = valid_mask & (depth_m > 0.01) & (depth_m <= z_max)
    if not np.any(graspable_mask):
        return vis_frame

    highlight_overlay = vis_frame.copy()
    z_max_bound = max(z_max, z_min_bound + 0.01)
    depth_norm = np.clip(
        (depth_m - z_min_bound) / (z_max_bound - z_min_bound), 0.0, 1.0
    )
    depth_u8 = np.clip((1.0 - depth_norm) * 255.0, 0, 255).astype(np.uint8)
    jet_color_map = cv2.applyColorMap(depth_u8, cv2.COLORMAP_JET)
    highlight_overlay[graspable_mask] = jet_color_map[graspable_mask]

    return cv2.addWeighted(highlight_overlay, alpha, vis_frame, 1.0 - alpha, 0)


def draw_horizon_line_overlay(
    vis_frame: np.ndarray,
    grasp_center_2d: tuple[float, float],
    pitch_pos: float,
    roll_pos: float,
    fy: float,
    horizon_color: tuple[int, int, int] = COLOR_WHITE,
) -> np.ndarray:
    """
    Draw an artificial horizon line overlay tilted by wrist roll and shifted by pitch.

    Args:
        vis_frame: Target BGR image array.
        grasp_center_2d: Projected TCP coordinates (u, v) in pixels.
        pitch_pos: Wrist pitch joint angle in radians.
        roll_pos: Wrist roll joint angle in radians.
        fy: Focal length in pixels along the camera Y-axis.
        horizon_color: BGR color tuple for the horizon line.

    Returns:
        The annotated BGR image array.
    """
    vis_h, vis_w = vis_frame.shape[:2]
    u_vis = int(round(grasp_center_2d[0]))
    v_vis = int(round(grasp_center_2d[1]))

    scale_x = vis_w / 640.0
    scale_y = vis_h / 400.0

    # Vertical pitch offset (focal length * tan(pitch))
    delta_v = -fy * np.tan(pitch_pos)

    # Center of horizon line relative to reticle
    u_h = u_vis + delta_v * np.sin(roll_pos)
    v_h = v_vis + delta_v * np.cos(roll_pos)

    # Unit vector along the horizon line
    ux = np.cos(roll_pos)
    uy = -np.sin(roll_pos)

    # Unit vector perpendicular to horizon line pointing toward the ground
    px = np.sin(roll_pos)
    py = np.cos(roll_pos)

    # Spread wings out in center so they never overlap with the reticle
    gap = int(round(40 * scale_x))
    wing_len = int(round(25 * scale_x))
    end_tick_len = int(round(6 * scale_x))

    # Thinner horizon line (1px foreground, 2px outline)
    h_interior_thickness = max(2, int(round(1 * scale_x)))
    h_outline_thickness = h_interior_thickness + max(2, int(round(1 * scale_x)))

    # Evaluate vertical extent of horizon geometry relative to v_h
    y_rel_samples: list[float] = []
    for sign in (-1, 1):
        for s in (sign * gap, sign * (gap + wing_len)):
            y_rel_samples.append(float(s * uy))
        p_end_y = sign * (gap + wing_len) * uy
        y_rel_samples.append(float(p_end_y + end_tick_len * py))

    min_y_rel = min(y_rel_samples)
    max_y_rel = max(y_rel_samples)

    top_margin = max(4, int(round(8 * scale_y)))
    bottom_margin = vis_h - max(4, int(round(8 * scale_y)))

    # If the horizon line is off the top or bottom of the screen, stay pressed against
    # the respective edge and render with alpha 0.5
    alpha = 1.0
    if v_h + min_y_rel < top_margin:
        v_h = top_margin - min_y_rel
        alpha = 0.5
    elif v_h + max_y_rel > bottom_margin:
        v_h = bottom_margin - max_y_rel
        alpha = 0.5

    # Clamp u_h so wings stay on screen horizontally
    max_wing_dx = (gap + wing_len) * abs(ux) + end_tick_len
    u_h = float(np.clip(u_h, max_wing_dx + 8, vis_w - max_wing_dx - 8))

    draw_target = vis_frame if alpha >= 1.0 else vis_frame.copy()

    for sign in (-1, 1):
        p_start = (
            int(round(u_h + sign * gap * ux)),
            int(round(v_h + sign * gap * uy)),
        )
        p_end = (
            int(round(u_h + sign * (gap + wing_len) * ux)),
            int(round(v_h + sign * (gap + wing_len) * uy)),
        )
        # Outer tip downward tick (pointing toward ground)
        p_tip = (
            int(round(p_end[0] + end_tick_len * px)),
            int(round(p_end[1] + end_tick_len * py)),
        )

        # Black outline underlay
        cv2.line(
            draw_target, p_start, p_end, COLOR_BLACK, h_outline_thickness, cv2.LINE_AA
        )
        cv2.line(
            draw_target, p_end, p_tip, COLOR_BLACK, h_outline_thickness, cv2.LINE_AA
        )

        # Foreground
        cv2.line(
            draw_target,
            p_start,
            p_end,
            horizon_color,
            h_interior_thickness,
            cv2.LINE_AA,
        )
        cv2.line(
            draw_target,
            p_end,
            p_tip,
            horizon_color,
            h_interior_thickness,
            cv2.LINE_AA,
        )

    if alpha < 1.0:
        cv2.addWeighted(draw_target, alpha, vis_frame, 1.0 - alpha, 0, vis_frame)

    return vis_frame


def draw_robot_icon_overlay(
    vis_frame: np.ndarray,
    arm_pos: float,
    yaw_pos: float,
    arm_lim: tuple[float, float] = DEFAULT_ARM_LIMITS,
    yaw_lim: tuple[float, float] = DEFAULT_YAW_LIMITS,
    is_in_collision: bool = False,
    icon_color: tuple[int, int, int] = COLOR_MANIFOLD,
    scale: float = DEFAULT_ICON_SCALE,
    keepout_slice_deg: float = DEFAULT_KEEPOUT_SLICE_DEG,
) -> np.ndarray:
    """
    Draw a schematic robot state icon showing base, arm extension, and wrist yaw.

    Args:
        vis_frame: Target BGR image array.
        arm_pos: Current arm extension position in meters.
        yaw_pos: Current wrist yaw position in radians.
        arm_lim: Minimum and maximum extension boundaries in meters for the arm.
        yaw_lim: Minimum and maximum angle boundaries in radians for wrist yaw.
        is_in_collision: Flag indicating whether robot is in self-collision.
        icon_color: Base BGR color tuple for the robot base and track.
        scale: Sizing gain factor preserving aspect ratio.
        keepout_slice_deg: Angular width of the unreachable workspace slice in degrees.

    Returns:
        The annotated BGR image array.
    """
    gain = scale
    base_radius = int(round(20 * gain))
    min_arm_len = int(round(20 * gain))
    max_arm_len = int(round(75 * gain))
    end_len = int(round(30 * gain))
    fingertip_radius = max(2, int(round(4 * gain)))
    line_thickness = max(1, int(round(3 * gain)))
    outline_px = max(1, int(round(2 * gain)))
    border_thickness = line_thickness + 2 * outline_px
    margin = max(10, int(round(25 * gain)))

    h, w = vis_frame.shape[:2]

    cx = w - margin - base_radius
    cy = h - margin - base_radius

    # Dynamic arm extension meter calculation (20px empty to 75px full)
    if arm_lim[1] > arm_lim[0]:
        arm_norm = float(
            np.clip((arm_pos - arm_lim[0]) / (arm_lim[1] - arm_lim[0]), 0.0, 1.0)
        )
    else:
        arm_norm = 0.0
    current_arm_len = min_arm_len + arm_norm * (max_arm_len - min_arm_len)

    arm_shaded_end_y = int(round(cy - current_arm_len))
    arm_full_end_y = int(round(cy - max_arm_len))

    # Color transitions near limits
    t_arm = compute_limit_danger_factor(arm_pos, arm_lim[0], arm_lim[1], zone_pct=0.10)
    arm_fill_color = interpolate_bgr((0, 200, 0), COLOR_RED, t_arm)

    t_yaw = compute_limit_danger_factor(yaw_pos, yaw_lim[0], yaw_lim[1], zone_pct=0.10)
    gripper_base_color = COLOR_ORANGE if is_in_collision else (0, 200, 0)
    gripper_color = interpolate_bgr(gripper_base_color, COLOR_RED, t_yaw)

    base_color = icon_color

    # Gripper line rotates with yaw and attaches to the tip of the shaded arm section
    gripper_angle = -np.pi / 2.0 - yaw_pos
    gripper_end_x = int(round(cx + end_len * np.cos(gripper_angle)))
    gripper_end_y = int(round(arm_shaded_end_y + end_len * np.sin(gripper_angle)))

    # 1. Semi-transparent fill for track
    alpha = 0.5
    overlay = np.zeros_like(vis_frame)
    cv2.line(
        overlay,
        (cx, cy),
        (cx, arm_full_end_y),
        icon_color,
        line_thickness,
        cv2.LINE_AA,
    )
    mask = (overlay > 0).any(axis=-1)
    vis_frame[mask] = cv2.addWeighted(overlay, alpha, vis_frame, 1.0 - alpha, 0.0)[mask]

    # 2. Base circle
    cv2.circle(
        vis_frame, (cx, cy), base_radius, COLOR_BLACK, border_thickness, cv2.LINE_AA
    )
    cv2.circle(
        vis_frame, (cx, cy), base_radius, base_color, line_thickness, cv2.LINE_AA
    )

    # 3. Gripper workspace: 330-degree reachable workspace sweep fill (grey)
    half_slice = keepout_slice_deg / 2.0
    sweep_fill = (100, 100, 100)
    sweep_overlay = np.zeros_like(vis_frame)
    cv2.ellipse(
        sweep_overlay,
        (cx, arm_shaded_end_y),
        (end_len, end_len),
        0,
        half_slice,
        360.0 - half_slice,
        sweep_fill,
        -1,
    )
    sweep_mask = (sweep_overlay > 0).any(axis=-1)
    sweep_alpha = 0.35
    vis_frame[sweep_mask] = cv2.addWeighted(
        sweep_overlay,
        sweep_alpha,
        vis_frame,
        1.0 - sweep_alpha,
        0.0,
    )[sweep_mask]

    # Radial stop lines bounding the keep-out wedge
    edge_color = COLOR_BLACK
    rad_top = np.radians(-half_slice)
    rad_bot = np.radians(half_slice)
    r_top_x = int(round(cx + end_len * np.cos(rad_top)))
    r_top_y = int(round(arm_shaded_end_y + end_len * np.sin(rad_top)))
    r_bot_x = int(round(cx + end_len * np.cos(rad_bot)))
    r_bot_y = int(round(arm_shaded_end_y + end_len * np.sin(rad_bot)))
    cv2.line(
        vis_frame,
        (cx, arm_shaded_end_y),
        (r_top_x, r_top_y),
        edge_color,
        1,
        cv2.LINE_AA,
    )
    cv2.line(
        vis_frame,
        (cx, arm_shaded_end_y),
        (r_bot_x, r_bot_y),
        edge_color,
        1,
        cv2.LINE_AA,
    )

    # Outer sweep arc
    cv2.ellipse(
        vis_frame,
        (cx, arm_shaded_end_y),
        (end_len, end_len),
        0,
        half_slice,
        360.0 - half_slice,
        edge_color,
        1,
        cv2.LINE_AA,
    )

    # 4. Arm bar render
    cv2.line(
        vis_frame,
        (cx, cy),
        (cx, arm_shaded_end_y),
        COLOR_BLACK,
        border_thickness,
        cv2.LINE_AA,
    )
    cv2.line(
        vis_frame,
        (cx, cy),
        (cx, arm_shaded_end_y),
        arm_fill_color,
        line_thickness,
        cv2.LINE_AA,
    )

    # 5. Gripper bar render
    cv2.line(
        vis_frame,
        (cx, arm_shaded_end_y),
        (gripper_end_x, gripper_end_y),
        COLOR_BLACK,
        border_thickness,
        cv2.LINE_AA,
    )
    cv2.line(
        vis_frame,
        (cx, arm_shaded_end_y),
        (gripper_end_x, gripper_end_y),
        gripper_color,
        line_thickness,
        cv2.LINE_AA,
    )

    # 6. Fingertip circle
    cv2.circle(
        vis_frame,
        (gripper_end_x, gripper_end_y),
        fingertip_radius,
        COLOR_BLACK,
        -1,
        cv2.LINE_AA,
    )

    return vis_frame
