"""Small rclpy helpers shared by the robot bridge."""

import asyncio
import logging
import math
from typing import Any

from rcl_interfaces.msg import Parameter, ParameterType, ParameterValue
from rcl_interfaces.srv import GetParameters, SetParameters
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rosidl_runtime_py.convert import message_to_ordereddict

log = logging.getLogger(__name__)


class ServiceUnavailable(RuntimeError):
    pass


def subscription_qos(node: Node, topic: str, depth: int = 10) -> QoSProfile:
    """QoS that matches whoever publishes ``topic`` right now.

    When publishers exist we copy them, so a transient-local publisher still hands us its latched
    message. When none exist yet we pick best-effort + volatile, which is
    compatible with any publisher that shows up later.
    """
    infos = node.get_publishers_info_by_topic(topic)
    if not infos:
        return QoSProfile(
            depth=depth,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
    reliability = (
        ReliabilityPolicy.BEST_EFFORT
        if any(
            i.qos_profile.reliability == ReliabilityPolicy.BEST_EFFORT for i in infos
        )
        else ReliabilityPolicy.RELIABLE
    )
    durability = (
        DurabilityPolicy.TRANSIENT_LOCAL
        if all(
            i.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL for i in infos
        )
        else DurabilityPolicy.VOLATILE
    )
    return QoSProfile(depth=depth, reliability=reliability, durability=durability)


def to_dict(msg) -> dict:
    """A ROS message as the plain dict rosbridge would have sent as JSON."""
    return _plain(message_to_ordereddict(msg))


def _plain(value):
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None  # JSON.stringify turns NaN/Infinity into null
    return value


def stamp_to_dict(stamp) -> dict:
    return {"sec": stamp.sec, "nanosec": stamp.nanosec}


async def wrap_future(rclpy_future, loop: asyncio.AbstractEventLoop):
    """Await an rclpy Future from asyncio."""
    future = loop.create_future()

    def done(f):
        def resolve():
            if future.done():
                return
            exc = f.exception()
            if exc is not None:
                future.set_exception(exc)
            else:
                future.set_result(f.result())

        loop.call_soon_threadsafe(resolve)

    rclpy_future.add_done_callback(done)
    return await future


async def wait_for_ready(is_ready, timeout: float) -> bool:
    """Poll ``is_ready()`` until it is true or ``timeout`` seconds pass."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not is_ready():
        if asyncio.get_running_loop().time() >= deadline:
            return False
        await asyncio.sleep(0.05)
    return True


async def call_service(client, request, loop, timeout: float = 5.0, wait: float = 0.0):
    """Call a service; raise ServiceUnavailable if no server shows up within ``wait`` s."""
    if not client.service_is_ready() and not await wait_for_ready(
        client.service_is_ready, wait
    ):
        raise ServiceUnavailable(client.srv_name)
    return await asyncio.wait_for(
        wrap_future(client.call_async(request), loop), timeout
    )


# ------------------------------------------------------------- parameters


def parameter_value_to_python(value: ParameterValue) -> Any:
    t = value.type
    if t == ParameterType.PARAMETER_BOOL:
        return value.bool_value
    if t == ParameterType.PARAMETER_INTEGER:
        return value.integer_value
    if t == ParameterType.PARAMETER_DOUBLE:
        return value.double_value
    if t == ParameterType.PARAMETER_STRING:
        return value.string_value
    if t == ParameterType.PARAMETER_BYTE_ARRAY:
        return list(value.byte_array_value)
    if t == ParameterType.PARAMETER_BOOL_ARRAY:
        return list(value.bool_array_value)
    if t == ParameterType.PARAMETER_INTEGER_ARRAY:
        return list(value.integer_array_value)
    if t == ParameterType.PARAMETER_DOUBLE_ARRAY:
        return list(value.double_array_value)
    if t == ParameterType.PARAMETER_STRING_ARRAY:
        return list(value.string_array_value)
    return None


def python_to_parameter_value(value: Any) -> ParameterValue:
    pv = ParameterValue()
    if isinstance(value, bool):
        pv.type, pv.bool_value = ParameterType.PARAMETER_BOOL, value
    elif isinstance(value, int):
        pv.type, pv.integer_value = ParameterType.PARAMETER_INTEGER, value
    elif isinstance(value, float):
        pv.type, pv.double_value = ParameterType.PARAMETER_DOUBLE, value
    elif isinstance(value, str):
        pv.type, pv.string_value = ParameterType.PARAMETER_STRING, value
    else:
        raise TypeError(f"unsupported parameter type {type(value)}")
    return pv


class RemoteParameters:
    """Get and set parameters on another node, like roslibjs' Param did via rosapi."""

    def __init__(self, node: Node, target_node: str, loop: asyncio.AbstractEventLoop):
        target = target_node if target_node.startswith("/") else "/" + target_node
        self.target = target
        self.loop = loop
        self.get_client = node.create_client(GetParameters, f"{target}/get_parameters")
        self.set_client = node.create_client(SetParameters, f"{target}/set_parameters")

    async def get(self, name: str, wait: float = 3.0, timeout: float = 3.0) -> Any:
        """The parameter's value, or None if the node or parameter is missing."""
        request = GetParameters.Request(names=[name])
        try:
            response = await call_service(
                self.get_client, request, self.loop, timeout, wait
            )
        except (ServiceUnavailable, asyncio.TimeoutError) as error:
            log.info(
                "parameter %s:%s unavailable (%s)",
                self.target,
                name,
                type(error).__name__,
            )
            return None
        if not response.values:
            return None
        return parameter_value_to_python(response.values[0])

    async def set(
        self, name: str, value: Any, wait: float = 3.0, timeout: float = 5.0
    ) -> bool:
        """True once the node has answered.

        A rejection is logged but still counts as answered, the way roslibjs'
        Param.set called back on any reply: the driver reports the mode it
        actually ended up in on /mode, which is what the caller tracks.
        """
        request = SetParameters.Request(
            parameters=[Parameter(name=name, value=python_to_parameter_value(value))]
        )
        try:
            response = await call_service(
                self.set_client, request, self.loop, timeout, wait
            )
        except (ServiceUnavailable, asyncio.TimeoutError) as error:
            log.warning(
                "could not set %s:%s (%s)", self.target, name, type(error).__name__
            )
            return False
        result = response.results[0] if response.results else None
        if result is not None and not result.successful:
            log.warning("set %s:%s rejected: %s", self.target, name, result.reason)
        return True
