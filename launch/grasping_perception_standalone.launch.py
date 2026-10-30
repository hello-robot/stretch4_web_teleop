"""Launch description for standalone grasping perception with robot driver and camera."""

from ament_index_python.packages import get_package_share_path
from launch_ros.actions import Node

from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import PathJoinSubstitution


def generate_launch_description() -> LaunchDescription:
    """
    Generate launch description for standalone grasping perception system.

    Launches the Stretch robot driver, the gripper camera driver, and the
    grasping perception node.

    Args:
        None.

    Returns:
        Configured LaunchDescription containing the pipeline actions.
    """
    core_package = str(get_package_share_path("stretch_core"))

    # Stretch Driver Launch
    stretch_driver_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([core_package, "launch", "stretch_driver.launch.py"])
        ),
    )

    # Gripper Camera Driver Launch
    gripper_camera_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([core_package, "launch", "gripper_camera.launch.py"])
        ),
    )

    # Grasping Perception Node
    grasping_perception_node = Node(
        package="stretch4_web_teleop",
        executable="grasping_perception_node.py",
        name="grasping_perception_node",
        output="screen",
    )

    return LaunchDescription(
        [
            stretch_driver_launch,
            gripper_camera_launch,
            grasping_perception_node,
        ]
    )
