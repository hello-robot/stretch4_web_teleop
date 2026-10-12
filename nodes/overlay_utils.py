#!/usr/bin/env python3
"""
Pure Python image manipulation and overlay utilities for grasping perception.

Provides modular computer vision primitives and rendering routines for:
1. Tool Center Point (TCP) crosshair reticle with dynamic color states.
2. Compliant fingertip swept volume manifold rendering and mask computation.
3. RGB-D surface point depth heatmaps (JET colormap).
4. Spatial evaluation masks and grasp readiness classification.
"""

from typing import Any

import cv2
import numpy as np

# ==============================================================================
# PERCEPTION & THRESHOLD CONSTANTS
# ==============================================================================
N_POINTS_MIN_YELLOW: int = 100
N_POINTS_MIN_GREEN: int = 1000
Z_NEAR_M: float = 0.20
WINDOW_HALF_WIDTH_M: float = 0.02
RETICLE_RADIUS_M: float = 0.005
GRASP_Z_MAX_DEFAULT: float = 0.259
DEFAULT_TCP_Z: float = 0.216

STATE_RED: int = 0
STATE_YELLOW: int = 1
STATE_GREEN: int = 2

# Color definitions (BGR)
COLOR_RED: tuple[int, int, int] = (0, 0, 255)
COLOR_YELLOW: tuple[int, int, int] = (0, 255, 255)
COLOR_GREEN: tuple[int, int, int] = (0, 255, 0)
COLOR_BLACK: tuple[int, int, int] = (0, 0, 0)
COLOR_MANIFOLD: tuple[int, int, int] = (128, 128, 128)
COLOR_WIREFRAME: tuple[int, int, int] = (180, 180, 180)


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
