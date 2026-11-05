#!/usr/bin/env python3

"""Node providing a ROS 2 service to safely trigger system shutdown."""

import subprocess
import threading
from typing import Any

import rclpy
from rclpy.node import Node
from std_srvs.srv import Trigger


class ShutdownRobotNode(Node):
    """ROS 2 node that advertises a service to power off the robot."""

    def __init__(self) -> None:
        """Initialize the ShutdownRobotNode and declare its parameters and services."""
        super().__init__("shutdown_robot_node")

        self.declare_parameter("dry_run", False)
        self.declare_parameter("shutdown_delay_s", 5.0)

        self._srv = self.create_service(
            Trigger,
            "/system/shutdown",
            self._handle_shutdown,
        )
        self.get_logger().info("Shutdown service ready on /system/shutdown")

    def _handle_shutdown(
        self,
        request: Trigger.Request,
        response: Trigger.Response,
    ) -> Trigger.Response:
        """
        Handle requests to shut down the host robot.

        Args:
            request: The service request.
            response: The service response to populate.

        Returns:
            The populated service response confirming shutdown initiation.
        """
        dry_run: bool = bool(self.get_parameter("dry_run").value)
        delay_s: float = float(self.get_parameter("shutdown_delay_s").value)

        self.get_logger().warn(
            f"Shutdown triggered. Host will power off in {delay_s:.1f}s (dry_run={dry_run})."
        )

        response.success = True
        response.message = (
            f"System poweroff scheduled in {delay_s:.1f} seconds (dry_run={dry_run})."
        )

        timer = threading.Timer(delay_s, self._execute_poweroff, args=(dry_run,))
        timer.daemon = True
        timer.start()

        return response

    def _execute_poweroff(self, dry_run: bool) -> None:
        """
        Execute the system poweroff command after the scheduled delay.

        Attempts passwordless sudo first to bypass multi-user/RDP polkit restrictions,
        falling back to standard systemctl if sudo fails or is unavailable.

        Args:
            dry_run: If True, log command execution without calling poweroff.
        """
        cmd_sudo = ["sudo", "-n", "systemctl", "poweroff"]
        cmd_fallback = ["systemctl", "poweroff"]

        if dry_run:
            self.get_logger().info(
                f"[DRY RUN] Would execute command: {' '.join(cmd_sudo)} "
                f"(or fallback: {' '.join(cmd_fallback)})"
            )
            return

        self.get_logger().warn(f"Executing shutdown command: {' '.join(cmd_sudo)}")
        try:
            subprocess.run(cmd_sudo, check=True)
            return
        except Exception as exc:  # pylint: disable=broad-except
            self.get_logger().warn(
                f"Passwordless sudo failed ({exc}); attempting fallback: {' '.join(cmd_fallback)}"
            )

        try:
            subprocess.run(cmd_fallback, check=True)
        except Exception as exc:  # pylint: disable=broad-except
            self.get_logger().error(f"Failed to execute shutdown command: {exc}")


def main(args: Any = None) -> None:
    """
    Entrypoint for the shutdown robot node.

    Args:
        args: Command-line arguments forwarded to rclpy.init.
    """
    rclpy.init(args=args)
    node = ShutdownRobotNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
