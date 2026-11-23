"""Playback joint velocities, derived from the end-effector speed ceiling.

A port of the velocity table in src/shared/util.tsx. The operator keeps its own
copy for held and stepped motion; the robot needs it to time pose playback
trajectories. See util.tsx for the reasoning behind each constant.
"""

import math

PROFILE_SCALES = {"slow": 0.75, "medium": 1.0, "fast": 2.0}
DEFAULT_MAX_EE_SPEED = 0.15
TOOL_SPEED_PER_UNIT = {
    "lift_joint": 1.0,
    "arm_joint": 1.0,
    "translate_mobile_base": 1.0,
    "rotate_mobile_base": 0.2862,
    "wrist_yaw_joint": 0.1065,
    "wrist_pitch_joint": 0.0608,
}
UNLIMITED_JOINT_VELOCITIES = {"gripper_joint": 0.075}
MOVE_TO_POSE_PLAYBACK_GAIN = 1.25
GRIPPER_ALIASES = {"stretch_gripper_joint", "gripper_aperture"}
ARM_ALIASES = {
    "wrist_extension",
    "arm_l0_joint",
    "arm_l1_joint",
    "arm_l2_joint",
    "arm_l3_joint",
    "arm_l4_joint",
}

_max_ee_speed = DEFAULT_MAX_EE_SPEED
DEFAULT_JOINT_VELOCITIES: dict[str, float] = {}


def _rebuild() -> None:
    limited = {
        joint: _max_ee_speed / (PROFILE_SCALES["fast"] * per_unit)
        for joint, per_unit in TOOL_SPEED_PER_UNIT.items()
    }
    wrist = min(limited["wrist_pitch_joint"], limited["wrist_yaw_joint"])
    DEFAULT_JOINT_VELOCITIES.update(UNLIMITED_JOINT_VELOCITIES)
    DEFAULT_JOINT_VELOCITIES.update(limited)
    DEFAULT_JOINT_VELOCITIES.update(
        {
            "wrist_roll_joint": wrist,
            "wrist_pitch_joint": wrist,
            "wrist_yaw_joint": wrist,
        }
    )


_rebuild()


def set_max_ee_speed(speed) -> bool:
    """Adopt a new ceiling (m/s). Returns True if it changed the table."""
    global _max_ee_speed
    if not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed <= 0:
        return False
    if speed == _max_ee_speed:
        return False
    _max_ee_speed = float(speed)
    _rebuild()
    return True


def get_max_ee_speed() -> float:
    return _max_ee_speed


def playback_joint_velocity(joint: str) -> float:
    resolved = joint
    if joint in GRIPPER_ALIASES:
        resolved = "gripper_joint"
    elif joint in ARM_ALIASES:
        resolved = "arm_joint"
    velocity = DEFAULT_JOINT_VELOCITIES.get(resolved) or DEFAULT_JOINT_VELOCITIES.get(
        joint
    )
    return (velocity or 0.1) * MOVE_TO_POSE_PLAYBACK_GAIN


def playback_joint_velocities(joints: list[str]) -> list[float]:
    return [playback_joint_velocity(j) for j in joints]
