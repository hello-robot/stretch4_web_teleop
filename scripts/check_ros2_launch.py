#!/usr/bin/env python3
"""Waits for web_interface.launch.py to come up and reports what did not.

`ros2 launch` keeps running when one of its nodes dies, a node can stay up
while the hardware behind it failed (a camera that never booted), and a
stretch_core or stretch_nav2 launch file that another launch is already running
is skipped rather than started twice. So neither "the launch is running" nor
"every node exists" means web teleop works. This checks, whoever started them:

  - that each node web teleop needs is in the ROS graph,
  - that the topics an operator sees are carrying data (the camera streams as
    web teleop publishes them, and the driver's joint states),
  - that no process died, read from the launch log, and
  - that no launch file web teleop reused is running with different arguments
    than web teleop asked for (e.g. a driver without the odom TF).

Usage:
    check_ros2_launch.py --log <web_interface_launch.txt> [--map] [--timeout 60]

Exit codes:
    0  everything web teleop needs is running
    1  something web teleop needs is not running or not working
    2  everything is running, but the launch log has errors worth a look
"""
import argparse
import os
import re
import sys
import time
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
BLUE = '\033[0;34m'
NC = '\033[0m'

INCLUDED = ('1', 'true', 'yes', 'on')

# Nodes web teleop cannot work without, by what an operator would call them.
# Keep in step with launch/web_interface.launch.py and the files it includes.
REQUIRED_NODES = {
    'stretch_driver': 'Stretch driver',
    'robot_state_publisher': 'Robot model (TF)',
    'luxonis_camera_node': 'Head camera',
    'luxonis_camera_node_gripper': 'Gripper camera',
    'rosbridge_websocket': 'Rosbridge (browser to ROS)',
    'tf2_web_republisher_node': 'TF republisher',
    'configure_video_streams_overhead': 'Overhead video stream',
    'configure_video_streams_gripper': 'Gripper video stream',
    'task_space_controller': 'Task space controller',
    'shutdown_robot_node': 'Shutdown service',
}
EE_VELOCITY_LIMITER_NODES = {
    'ee_velocity_safety_filter': 'End-effector velocity limiter',
}
NAVIGATION_NODES = {
    'map_server': 'Navigation: map server',
    'amcl': 'Navigation: localization',
    'planner_server': 'Navigation: planner',
    'controller_server': 'Navigation: controller',
    'bt_navigator': 'Navigation: behavior tree',
}
COLLISION_AVOIDANCE_NODES = {
    'collision_monitor': 'Collision avoidance',
}

# Topics that must carry data, as (label, message type). The video topics are
# what configure_video_streams.py publishes for the browser, so data on them
# means the camera booted and the stream behind it works end to end.
REQUIRED_TOPICS = {
    '/navigation_camera/image_raw/rotated/compressed': ('Head camera video', 'sensor_msgs.msg.CompressedImage'),
    '/gripper_camera/image_raw/cropped/compressed': ('Gripper camera video', 'sensor_msgs.msg.CompressedImage'),
    '/joint_states': ('Robot joint states', 'sensor_msgs.msg.JointState'),
}

# Errors these setups log on every launch, and that do not mean anything failed.
# rosbridge logs a browser's failed requests (e.g. /map_server/map in map-less
# mode) as errors; those are about the page, not the launch.
KNOWN_HARMLESS_ERRORS = re.compile(
    r'Model name OAK-FFC-3P not found|load firetimes error|Inflation layer either not found|rcl_shutdown already called'
    r'|\[rosbridge_websocket\]: \[Client '
)
PROCESS_DIED = re.compile(r'\[ERROR\] \[([^\]]+)\]: process has died \[pid \d+, exit code (-?\d+)')
# Logged by hello_helpers.launch_utils.launch_singleton when it skips a launch file.
SINGLETON_SKIPPED = re.compile(r'\[launch singleton\] (.*)')
DIFFERENT_ARGUMENTS = 'started with different arguments'
# How long to keep watching after the first process dies, to catch the ones that go with it.
DEATH_GRACE_SEC = 3.0
# Lines of a dead node's own output to show; its traceback is at the end.
DIED_NODE_TAIL_LINES = 15
# The most common cause of a missing executable or package: source pulled or
# edited without rebuilding the workspace, so install/ lacks it.
OUT_OF_DATE_INSTALL = re.compile(r"not found on the libexec directory|[Pp]ackage '[^']+' not found")
NOT_FOUND_PACKAGE = re.compile(r"[Pp]ackage '([^']+)' not found|install/([^/]+)/lib")


def launch_is_running(pattern: str) -> bool:
    uid = os.getuid()
    me = os.getpid()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == me:
            continue
        try:
            if proc.stat().st_uid != uid:
                continue
            if pattern in (proc / 'cmdline').read_bytes().decode(errors='replace'):
                return True
        except OSError:
            continue
    return False


def read_log(path: Path) -> list:
    try:
        return path.read_text(errors='replace').splitlines()
    except OSError:
        return []


def required_nodes(with_map: bool) -> dict:
    nodes = dict(REQUIRED_NODES)
    if os.environ.get('FEATURE_EE_VELOCITY_LIMITER', '1').lower() in INCLUDED:
        nodes.update(EE_VELOCITY_LIMITER_NODES)
    if with_map:
        nodes.update(NAVIGATION_NODES)
    elif os.environ.get('FEATURE_LOCAL_COLLISION_AVOIDANCE', '0').lower() in INCLUDED:
        nodes.update(COLLISION_AVOIDANCE_NODES)
    return nodes


def died_node_output(log: list, tag: str) -> list:
    """The last lines a process wrote. ros2 launch prefixes a process's output with [<tag>]."""
    prefix = f'[{tag}] '
    return [line for line in log if line.startswith(prefix)][-DIED_NODE_TAIL_LINES:]


def rebuild_hint(error_lines: list) -> str:
    text = '\n'.join(error_lines)
    if not OUT_OF_DATE_INSTALL.search(text):
        return ''
    m = NOT_FOUND_PACKAGE.search(text)
    package = (m.group(1) or m.group(2)) if m else ''
    return ('The installed workspace looks out of date with the source. Rebuild it:\n'
            f"    cd ~/ament_ws && colcon build{' --packages-select ' + package if package else ''}")


def env_seconds(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def message_type(dotted: str):
    module, name = dotted.rsplit('.', 1)
    return getattr(__import__(module, fromlist=[name]), name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--log', required=True, type=Path, help='output of ros2 launch')
    parser.add_argument('--map', action='store_true', help='a map was given, so navigation should be up')
    parser.add_argument('--launch-pattern', default='web_interface.launch.py',
                        help='command line text that identifies the launch process')
    parser.add_argument('--timeout', type=float, default=env_seconds('WEB_TELEOP_ROS_TIMEOUT_SECONDS', 60.0),
                        help='seconds to wait for everything to come up (env: WEB_TELEOP_ROS_TIMEOUT_SECONDS)')
    parser.add_argument('--settle', type=float, default=env_seconds('WEB_TELEOP_ROS_SETTLE_SECONDS', 5.0),
                        help='seconds to keep watching once everything is up, for anything that dies right away '
                             '(env: WEB_TELEOP_ROS_SETTLE_SECONDS)')
    args = parser.parse_args()

    import rclpy
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy

    expected_nodes = required_nodes(args.map)
    print(f'Waiting for {len(expected_nodes)} ROS2 nodes and {len(REQUIRED_TOPICS)} data streams '
          f'(up to {args.timeout:.0f}s)...', flush=True)

    rclpy.init()
    node = Node('web_teleop_launch_check')
    received = set()
    # Best effort matches both best effort and reliable publishers.
    qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
    subscriptions = []
    for topic, (_, type_name) in REQUIRED_TOPICS.items():
        subscriptions.append(node.create_subscription(
            message_type(type_name), topic, lambda _msg, t=topic: received.add(t), qos))

    start = time.monotonic()
    ready_since = None
    first_death = None
    launch_alive = True
    seen = set()
    log = []
    try:
        while True:
            rclpy.spin_once(node, timeout_sec=0.5)
            now = time.monotonic()
            log = read_log(args.log)
            seen = {name for name, ns in node.get_node_names_and_namespaces() if ns == '/'}
            launch_alive = launch_is_running(args.launch_pattern)
            died = any(PROCESS_DIED.search(line) for line in log)

            if not launch_alive:
                break
            if died:
                first_death = first_death or now
                if now - first_death >= DEATH_GRACE_SEC:
                    break
            if all(n in seen for n in expected_nodes) and len(received) == len(REQUIRED_TOPICS):
                ready_since = ready_since or now
                if now - ready_since >= args.settle:
                    break
            if now - start >= args.timeout:
                break
    finally:
        for sub in subscriptions:
            node.destroy_subscription(sub)
        node.destroy_node()
        rclpy.try_shutdown()

    deaths = {}
    for line in log:
        m = PROCESS_DIED.search(line)
        if m:
            deaths[m.group(1)] = m.group(2)
    reused = [m.group(1) for m in map(SINGLETON_SKIPPED.search, log) if m]
    reused_mismatched = [msg for msg in reused if DIFFERENT_ARGUMENTS in msg]
    reused_matching = [msg for msg in reused if DIFFERENT_ARGUMENTS not in msg]
    other_errors = [line for line in log
                    if 'ERROR' in line and not PROCESS_DIED.search(line) and not KNOWN_HARMLESS_ERRORS.search(line)]
    missing_nodes = [n for n in expected_nodes if n not in seen]
    silent_topics = [t for t in REQUIRED_TOPICS if t not in received]

    print('')
    print('ROS2 nodes:')
    for name, label in expected_nodes.items():
        if name in seen:
            print(f'  {GREEN}OK{NC}       {label} ({name})')
        else:
            print(f'  {RED}MISSING{NC}  {label} ({name})')
    print('Data:')
    for topic, (label, _) in REQUIRED_TOPICS.items():
        if topic in received:
            print(f'  {GREEN}OK{NC}       {label} ({topic})')
        else:
            print(f'  {RED}NO DATA{NC}  {label} ({topic})')

    if reused_matching:
        print('')
        print(f'{BLUE}Already running in another launch, so reused rather than started again:{NC}')
        for msg in reused_matching:
            print(f'  {msg}')

    failed = False
    if not launch_alive:
        failed = True
        print('')
        print(f'{RED}ERROR:{NC} ros2 launch exited. Last lines of {args.log}:')
        for line in log[-25:]:
            print(f'    {line}')
    if deaths:
        failed = True
        print('')
        print(f'{RED}ERROR:{NC} These processes died:')
        for proc, code in deaths.items():
            print(f'  {proc} (exit code {code})')
        for proc in deaths:
            output = died_node_output(log, proc)
            if output:
                print('')
                print(f'{BLUE}Last output from {proc}:{NC}')
                for line in output:
                    print(f'    {line}')
    if reused_mismatched:
        failed = True
        print('')
        print(f'{RED}ERROR:{NC} Web teleop reused these from another launch, but they run with different '
              'arguments than web teleop needs. Stop that launch and relaunch web teleop:')
        for msg in reused_mismatched:
            print(f'  {msg}')
    if missing_nodes:
        failed = True
        print('')
        print(f'{RED}ERROR:{NC} Not running: ' + ', '.join(expected_nodes[n] for n in missing_nodes) + '.')
    if silent_topics:
        failed = True
        print('')
        print(f'{RED}ERROR:{NC} No data after {time.monotonic() - start:.0f}s: '
              + ', '.join(REQUIRED_TOPICS[t][0] for t in silent_topics)
              + '. A node can be running while the hardware behind it failed; see the launch output.')
    if (missing_nodes or silent_topics) and reused:
        print('  Some of these were left to another launch (above). If it is the one not working, '
              'stop it and relaunch.')
    if other_errors:
        print('')
        print(f'{YELLOW}WARNING:{NC} The launch log has errors:')
        for line in other_errors[:20]:
            print(f'  {line}')
        if len(other_errors) > 20:
            print(f'  ...and {len(other_errors) - 20} more.')

    hint = rebuild_hint([line for line in log if 'ERROR' in line])
    if hint:
        print('')
        print(f'{BLUE}Hint:{NC} {hint}')

    print(f'Full launch output: {args.log}')
    if failed:
        return 1
    return 2 if other_errors else 0


if __name__ == '__main__':
    sys.exit(main())
