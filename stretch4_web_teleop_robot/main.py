"""Run the robot peer: rclpy on executor threads, WebRTC and signaling on asyncio."""

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading
from pathlib import Path

import rclpy
from rclpy.executors import ExternalShutdownException, MultiThreadedExecutor
from rclpy.node import Node

from .session import Session
from .signaling import create_signaler

log = logging.getLogger("robot_peer")
REPO_DIR = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> None:
    """Minimal .env reader (KEY=VALUE); the environment wins, as with dotenv."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


async def run(node: Node, args) -> int:
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    session = Session(node, loop, args.microphone, args.server_url)
    start = loop.create_task(session.start(create_signaler))
    failed = False

    def started(task: asyncio.Task) -> None:
        nonlocal failed
        if not task.cancelled() and task.exception() is not None:
            log.error("Robot peer failed to start", exc_info=task.exception())
            failed = True
            stop.set()  # exit non-zero; the ROS launch respawns us

    start.add_done_callback(started)

    async def report():
        while True:
            await asyncio.sleep(60)
            log.info(
                "camera frames received/decoded: navigation %d/%d, gripper %d/%d",
                session.navigation.frames_received,
                session.navigation.frames_decoded,
                session.gripper.frames_received,
                session.gripper.frames_decoded,
            )

    reporter = loop.create_task(report())
    await stop.wait()
    log.info("Shutting down robot peer")
    start.cancel()
    reporter.cancel()
    try:
        await asyncio.wait_for(session.stop(), 5.0)
    except Exception:  # noqa: BLE001 - leave regardless
        log.exception("Unclean shutdown")
    return 1 if failed else 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Stretch web teleop robot peer")
    parser.add_argument(
        "--microphone",
        default=os.environ.get("WEB_TELEOP_ROBOT_MICROPHONE", "alsa:default"),
        help="FFmpeg <format>:<device> for the robot microphone, or 'off' (default: alsa:default)",
    )
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WEB_TELEOP_SERVER_URL", "https://localhost"),
        help="the robot's own web server (local signaling and voice tokens)",
    )
    parser.add_argument(
        "--log-level", default=os.environ.get("WEB_TELEOP_LOG_LEVEL", "INFO")
    )
    args, ros_args = parser.parse_known_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    for noisy in ("aioice", "aiortc", "socketio", "engineio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    load_dotenv(REPO_DIR / ".env")
    os.environ.setdefault("WEB_TELEOP_SERVER_URL", args.server_url)

    rclpy.init(args=ros_args)
    node = Node("web_teleop_robot")
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)

    def spin():
        try:
            executor.spin()
        except ExternalShutdownException:
            pass

    spinner = threading.Thread(target=spin, name="rclpy", daemon=True)
    spinner.start()
    # Not asyncio.run(): its own SIGINT handler would cancel run() before the
    # robot is stopped and the signaling seat released.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    status = 1
    try:
        status = loop.run_until_complete(run(node, args))
    finally:
        # Let cancelled tasks (aiortc senders, relays, retries) unwind before
        # the loop closes, instead of being destroyed while pending.
        loop.run_until_complete(_cancel_remaining_tasks())
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()
        executor.shutdown(timeout_sec=1.0)
        spinner.join(timeout=2.0)
        node.destroy_node()
        rclpy.try_shutdown()
    sys.exit(status)


async def _cancel_remaining_tasks() -> None:
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


if __name__ == "__main__":
    main()
