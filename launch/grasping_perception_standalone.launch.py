import os
from ament_index_python.packages import get_package_share_path
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node


def generate_launch_description():
    core_package = str(get_package_share_path("stretch_core"))

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
            gripper_camera_launch,
            grasping_perception_node,
        ]
    )
