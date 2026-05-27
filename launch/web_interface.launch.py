import fnmatch
import os
import sys

from ament_index_python import get_package_share_directory
from ament_index_python.packages import get_package_share_path
from launch_ros.actions import Node
from stretch4_body.core.robot_params import RobotParams

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    ExecuteProcess,
    IncludeLaunchDescription,
)
from launch.launch_description_sources import (
    FrontendLaunchDescriptionSource,
    PythonLaunchDescriptionSource,
)
from launch.substitutions import (
    FindExecutable,
    LaunchConfiguration,
    PathJoinSubstitution,
)


def symlinks_to_has_head_cams():
    usb_device_seen = {
        "hello-nav-head-camera-stereo": False,
    }

    listOfFiles = os.listdir("/dev")
    pattern = "hello*"
    for entry in listOfFiles:
        if fnmatch.fnmatch(entry, pattern):
            usb_device_seen[entry] = True

    return all(usb_device_seen.values())


def check_valid_configuration(model, tool, has_head_cams):
    """Validates that the robot configuration is supported. Checks model, tool,
    and has_head_cams individually and exits with a targeted error message for
    whichever value is not recognised.
    """
    valid_models = ["SE4"]
    valid_tools = ["eoa_wrist_dw4_tool_sg4", "eoa_wrist_dw4_tool_tablet"]

    if model not in valid_models:
        print(
            f"[web_interface.launch.py] ERROR: Unsupported robot model {model!r}. "
            f"Valid models: {valid_models}",
            file=sys.stderr,
        )
        sys.exit(1)

    if tool not in valid_tools:
        print(
            f"[web_interface.launch.py] ERROR: Unsupported tool {tool!r} for model {model!r}. "
            f"Valid tools: {valid_tools}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not has_head_cams:
        print(
            "[web_interface.launch.py] ERROR: Head cameras not detected. "
            "Check that the /dev/hello-nav-head-camera-stereo symlink exists.",
            file=sys.stderr,
        )
        sys.exit(1)


def generate_launch_description():
    teleop_interface_package = str(get_package_share_path("stretch4_web_teleop"))
    core_package = str(get_package_share_path("stretch_core"))
    rosbridge_package = str(get_package_share_path("rosbridge_server"))
    # stretch_core_path = str(get_package_share_directory("stretch_core"))
    stretch_navigation_path = str(get_package_share_directory("stretch_nav2"))

    robot_params = RobotParams().get_params()[1]
    stretch_serial_no = robot_params["robot"]["serial_no"]
    stretch_model = robot_params["robot"]["model_name"]
    stretch_tool = robot_params["robot"]["tool"]
    stretch_has_head_cams = symlinks_to_has_head_cams()
    check_valid_configuration(stretch_model, stretch_tool, stretch_has_head_cams)

    # Declare launch arguments
    params_file = DeclareLaunchArgument(
        "params",
        default_value=[
            PathJoinSubstitution(
                [
                    teleop_interface_package,
                    "config",
                    "configure_video_streams_params.yaml",
                ]
            )
        ],
    )
    map_yaml = DeclareLaunchArgument(
        "map_yaml", description="filepath to previously captured map", default_value=""
    )
    certfile_arg = DeclareLaunchArgument(
        "certfile", default_value=stretch_serial_no + "+6.pem"
    )
    keyfile_arg = DeclareLaunchArgument(
        "keyfile", default_value=stretch_serial_no + "+6-key.pem"
    )
    nav2_params_file_param = DeclareLaunchArgument(
        "nav2_params_file",
        default_value=os.path.join(
            stretch_navigation_path,
            "config",
            "nav2_params_switch_controller.yaml",
        ),
        description="Full path to the ROS2 parameters file to use for all launched nodes",
    )

    bt_param = DeclareLaunchArgument(
        "bt_tree_path",
        default_value=os.path.join(
            stretch_navigation_path, "xml", "navigate_w_dynamic_controller.xml"
        ),
        description="Full path to the BT file to use for nav2_bt_navigator",
    )

    # Start collecting nodes to launch
    ld = LaunchDescription(
        [
            map_yaml,
            nav2_params_file_param,
            params_file,
            certfile_arg,
            keyfile_arg,
            bt_param,
        ]
    )

    tf2_web_republisher_node = Node(
        package="tf2_web_republisher",
        executable="tf2_web_republisher_node",
        name="tf2_web_republisher_node",
    )
    ld.add_action(tf2_web_republisher_node)

    # Stretch Driver
    stretch_driver_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([core_package, "launch", "stretch_driver.launch.py"])
        ),
        # TODO: The tablet_placement code should change the mode, not the launch file
        launch_arguments={
            "mode": "velocity",
            "broadcast_odom_tf": "True",
            "fail_out_of_range_goal": "False",
            "log_level": "info",
        }.items(),
    )
    ld.add_action(stretch_driver_launch)

    # Head Cameras
    luxonis_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([core_package, "launch", "luxonis.launch.py"])
        ),
        launch_arguments={
            "use_center": "true",
        }.items(),
    )
    ld.add_action(luxonis_launch)

    # Gripper Camera
    gripper_camera_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([core_package, "launch", "gripper_camera.launch.py"])
        ),
    )
    ld.add_action(gripper_camera_launch)

    # Rosbridge Websocket
    rosbridge_launch = IncludeLaunchDescription(
        FrontendLaunchDescriptionSource(
            PathJoinSubstitution(
                [rosbridge_package, "launch", "rosbridge_websocket_launch.xml"]
            )
        ),
        launch_arguments={
            "port": "9090",
            "address": "localhost",
            "ssl": "true",
            "certfile": PathJoinSubstitution(
                [
                    teleop_interface_package,
                    "certificates",
                    LaunchConfiguration("certfile"),
                ]
            ),
            "keyfile": PathJoinSubstitution(
                [
                    teleop_interface_package,
                    "certificates",
                    LaunchConfiguration("keyfile"),
                ]
            ),
            "authenticate": "false",
            "call_services_in_new_thread": "true",
        }.items(),
    )
    ld.add_action(rosbridge_launch)

    # Configure Video Streams
    labels = ["overhead", "gripper"]
    for i in range(len(labels)):
        bools = ["False", "False"]
        bools[i] = "True"
        label = labels[i]
        configure_video_streams_node = Node(
            package="stretch4_web_teleop",
            executable="configure_video_streams.py",
            name=f"configure_video_streams_{label}",
            output="screen",
            arguments=[
                LaunchConfiguration("params"),
                *bools,
            ],
            parameters=[
                {
                    "stretch_tool": stretch_tool,
                }
            ],
        )
        ld.add_action(configure_video_streams_node)

    ld.add_action(
        ExecuteProcess(
            cmd=[
                [
                    FindExecutable(name="ros2"),
                    " service call ",
                    "/reinitialize_global_localization ",
                    "std_srvs/srv/Empty ",
                    '"{}"',
                ]
            ],
            shell=True,
        ),
    )

    return ld
