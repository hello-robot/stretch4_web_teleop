/**
 * Pose playback states the robot reports in `playbackPosesState` messages.
 *
 * The strings are part of the wire protocol: the robot peer
 * (stretch4_web_teleop_robot/robot.py, MovementState) sends exactly these.
 */
export enum MovementState {
    Executing = "movement executing!",
    Success = "movement successful!",
    Cancel = "movement canceled!",
    Fail = "movement failed!",
}

export const movementStatesTerminal: MovementState[] = [
    MovementState.Success,
    MovementState.Cancel,
    MovementState.Fail,
];

export const movementStatesTransitory: MovementState[] = [MovementState.Executing];

export const movementStatesAll = Object.values(MovementState);
