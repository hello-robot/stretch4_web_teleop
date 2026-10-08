import fnmatch
import os
import sys

from ament_index_python import get_package_share_directory
from ament_index_python.packages import get_package_share_path
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from stretch4_body.core.robot_params import RobotParams

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    ExecuteProcess,
    GroupAction,
    IncludeLaunchDescription,
    OpaqueFunction,
)
from launch.conditions import IfCondition
from launch.launch_context import LaunchContext
from launch.launch_description_sources import (
    FrontendLaunchDescriptionSource,
    PythonLaunchDescriptionSource,
)
from launch.substitutions import (
    EnvironmentVariable,
    FindExecutable,
    LaunchConfiguration,
    NotEqualsSubstitution,
    PathJoinSubstitution,
    PythonExpression,
)

INCLUDED = ("1", "true", "yes", "on")


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
    valid_tools = [
        "eoa_wrist_dw4_tool_sg4",
        "eoa_wrist_dw4_tool_tablet",
        "eoa_wrist_dw4_tool_nil",
    ]

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
    stretch_tag_perception_path = FindPackageShare("stretch_tag_perception")

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

    # Error out if the map file does not exist
    def map_file_check(context: LaunchContext):
        map_path = LaunchConfiguration("map_yaml").perform(context)
        if map_path == "":
            return
        if not os.path.exists(map_path):
            msg = "Map file not found in given path: {}".format(map_path)
            raise FileNotFoundError(msg)
        if not map_path.endswith(".yaml"):
            msg = "Map file is not a yaml file: {}".format(map_path)
            raise FileNotFoundError(msg)

    map_path_check_action = OpaqueFunction(function=map_file_check)

    # Start collecting nodes to launch
    ld = LaunchDescription(
        [
            map_yaml,
            nav2_params_file_param,
            params_file,
            certfile_arg,
            keyfile_arg,
            bt_param,
            map_path_check_action,
        ]
    )

    # TF2 web republisher (streams TF frames to the web client)
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
            "action_timeout": "30.0",
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

    # Nav2 stack if a map_yaml is provided
    navigation_bringup_launch = GroupAction(
        condition=IfCondition(
            NotEqualsSubstitution(LaunchConfiguration("map_yaml"), "")
        ),
        actions=[
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    [
                        stretch_navigation_path,
                        "/launch/navigation_mppi.launch.py",
                    ]
                ),
                launch_arguments={
                    "use_sim_time": "false",
                    "autostart": "true",
                    "launch_driver": "false",
                    "map": LaunchConfiguration("map_yaml"),
                    "use_rviz": "false",
                    "action_timeout": "30.0",
                }.items(),
            ),
        ],
    )
    ld.add_action(navigation_bringup_launch)

    # Reset AMCL global localization (ros2 service call)
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
            condition=IfCondition(
                NotEqualsSubstitution(LaunchConfiguration("map_yaml"), "")
            ),
        ),
    )

    # Map-less collision avoidance
    standalone_collision_monitor_launch = GroupAction(
        condition=IfCondition(
            PythonExpression(
                [
                    "'",
                    LaunchConfiguration("map_yaml"),
                    "' == '' and '",
                    EnvironmentVariable(
                        "FEATURE_LOCAL_COLLISION_AVOIDANCE", default_value="0"
                    ),
                    f"'.lower() in {INCLUDED}",
                ]
            )
        ),
        actions=[
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    PathJoinSubstitution(
                        [
                            stretch_navigation_path,
                            "launch",
                            "collision_monitor.launch.py",
                        ]
                    )
                ),
                launch_arguments={
                    "launch_driver": "false",
                    "use_rviz": "false",
                    "tool_preset": "auto",
                }.items(),
            ),
        ],
    )
    ld.add_action(standalone_collision_monitor_launch)

    # ArUco Tag Perception Launch (Run for all cameras; suppress auxiliary RViz)
    aruco_perception_launch = IncludeLaunchDescription(
        PathJoinSubstitution(
            [stretch_tag_perception_path, "launch", "stretch_aruco.launch.py"]
        ),
        launch_arguments={
            "cameras": "all",
            "publish_markers": "false",
            "use_rviz": "false",
        }.items(),
    )
    ld.add_action(aruco_perception_launch)

    # Localization with aruco tag node
    aruco_localization_node = Node(
        package="stretch_nav2",
        executable="aruco_tag_localization.py",
        name="aruco_tag_localization",
        output="screen",
    )
    ld.add_action(aruco_localization_node)

    # Velocity limiter
    use_ee_velocity_limiter_arg = DeclareLaunchArgument(
        "use_ee_velocity_limiter",
        default_value=EnvironmentVariable(
            "FEATURE_EE_VELOCITY_LIMITER", default_value="1"
        ),
        description="Route motion through the end-effector velocity limiter",
    )
    max_ee_speed_arg = DeclareLaunchArgument(
        "max_ee_speed",
        default_value="0.2",  # m/s
        description="Maximum allowed end-effector linear speed in m/s",
    )
    target_frame_arg = DeclareLaunchArgument(
        "target_frame",
        default_value="tool_attachment_site_link",
        description="End-effector target frame for velocity calculation",
    )
    ld.add_action(use_ee_velocity_limiter_arg)
    ld.add_action(max_ee_speed_arg)
    ld.add_action(target_frame_arg)

    # When map_yaml is provided, navigation is active with collision_monitor listening
    # on /cmd_vel_nav. In addition, when map_yaml is empty, standalone_collision_monitor_launch
    # runs if FEATURE_LOCAL_COLLISION_AVOIDANCE is enabled, which also listens on /cmd_vel_nav.
    # In both cases, downstream base motion must target /cmd_vel_nav so obstacle stopping is enforced.
    # Otherwise, base motion targets /cmd_vel (stretch_driver direct).
    downstream_base_topic = PythonExpression(
        [
            "'/cmd_vel_nav' if ('",
            LaunchConfiguration("map_yaml"),
            "' != '' or '",
            EnvironmentVariable("FEATURE_LOCAL_COLLISION_AVOIDANCE", default_value="0"),
            f"'.lower() in {INCLUDED}) else '/cmd_vel'",
        ]
    )

    safety_filter_node = Node(
        package="stretch_kinematics",
        executable="velocity_limiter",
        name="ee_velocity_safety_filter",
        output="screen",
        condition=IfCondition(
            PythonExpression(
                [
                    "'",
                    LaunchConfiguration("use_ee_velocity_limiter"),
                    f"'.lower() in {INCLUDED}",
                ]
            )
        ),
        parameters=[
            {
                "max_ee_speed": LaunchConfiguration("max_ee_speed"),
                "target_frame": LaunchConfiguration("target_frame"),
                "input_cmd_vel_topic": "/teleop/cmd_vel",
                "output_cmd_vel_topic": downstream_base_topic,
                "input_cmd_vel_nav_topic": "/cmd_vel_nav_raw",
                "output_cmd_vel_nav_topic": "/cmd_vel_nav",
                "input_joint_vel_topic": "/teleop/joint_vel",
                "output_joint_vel_topic": "/joint_vel",
                "joint_states_topic": "/joint_states",
            }
        ],
    )
    ld.add_action(safety_filter_node)

    # Task space controller node (converts /ee_cmd_vel into base and arm commands)
    # When velocity limiter is enabled, commands route through /teleop/* topics.
    # When disabled, commands route directly to downstream base topic and /joint_vel.
    tsc_cmd_vel_topic = PythonExpression(
        [
            "'/teleop/cmd_vel' if '",
            LaunchConfiguration("use_ee_velocity_limiter"),
            f"'.lower() in {INCLUDED} else '",
            downstream_base_topic,
            "'",
        ]
    )
    tsc_joint_vel_topic = PythonExpression(
        [
            "'/teleop/joint_vel' if '",
            LaunchConfiguration("use_ee_velocity_limiter"),
            f"'.lower() in {INCLUDED} else '/joint_vel'",
        ]
    )

    task_space_controller_node = Node(
        package="stretch_kinematics",
        executable="task_space_controller",
        name="task_space_controller",
        output="screen",
        parameters=[
            {"target_frame": "tool_attachment_site_link"},
            {"control_rate": 15.0},
            {"watchdog_timeout": 0.4},
            {"cmd_vel_topic": tsc_cmd_vel_topic},
            {"joint_vel_topic": tsc_joint_vel_topic},
        ],
    )
    ld.add_action(task_space_controller_node)

    return ld
