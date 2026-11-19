import { Transform } from "roslib";
import { ROSPoint, ROSQuaternion } from "shared/util";

/** Map-frame yaw (radians) as the quaternion Nav2 uses for a goal heading. */
export function yawToQuaternion(yaw: number): ROSQuaternion {
    return {
        x: 0,
        y: 0,
        z: Math.sin(yaw / 2),
        w: Math.cos(yaw / 2),
    };
}

/** Tapped destination in the Transform shape saved locations already store. */
export function goalToTransform(position: ROSPoint, yaw: number): Transform {
    return {
        translation: {
            x: position.x,
            y: position.y,
            z: position.z ?? 0,
        },
        rotation: yawToQuaternion(yaw),
    } as Transform;
}
