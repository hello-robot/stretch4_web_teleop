import {
    JOINT_INCREMENTS,
    TASK_SPACE_LINEAR_VEL,
} from "shared/util";
import { ActionModeType } from "../utils/component_definitions";
import {
    ButtonFunctions,
} from "./ButtonFunctionProvider";
import { FunctionProvider } from "./FunctionProvider";

export enum FlyingGripperButton {
    Forward = "forward",
    Backward = "backward",
    Left = "left",
    Right = "right",
    Up = "up",
    Down = "down",
    GripperOpen = "gripper-open",
    GripperClose = "gripper-close",
}

/** Tool-frame unit vectors: [forward, left, up] per stretch4_kinematics teleop. */
const TRANSLATION: Record<
    FlyingGripperButton,
    readonly [number, number, number] | undefined
> = {
    [FlyingGripperButton.Forward]: [1, 0, 0],
    [FlyingGripperButton.Backward]: [-1, 0, 0],
    [FlyingGripperButton.Left]: [0, 1, 0],
    [FlyingGripperButton.Right]: [0, -1, 0],
    [FlyingGripperButton.Up]: [0, 0, 1],
    [FlyingGripperButton.Down]: [0, 0, -1],
    [FlyingGripperButton.GripperOpen]: undefined,
    [FlyingGripperButton.GripperClose]: undefined,
};

const GRIPPER_JOINT = "gripper_joint" as const;

/**
 * Flying-gripper pad: six tool-frame translations plus gripper open/close.
 */
export class FlyingGripperFunctionProvider extends FunctionProvider {
    private activeFlyingButton?: FlyingGripperButton;

    /**
     * Initializes the flying gripper function provider and binds handler methods.
     */
    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.disableActiveButton = this.disableActiveButton.bind(this);
    }

    /**
     * Clears the latched flying gripper button state whenever an action stops.
     */
    protected onActionStopped(): void {
        this.activeFlyingButton = undefined;
    }

    /**
     * Stops any active flying gripper movement and clears the latched button state.
     */
    public disableActiveButton() {
        this.stopCurrentAction(true);
    }

    /**
     * Stops an active gripper open or close command if the corresponding gripper direction reaches a limit or collision.
     *
     * Args:
     *     isOpenBlocked: True if gripper opening is in collision or at its upper limit.
     *     isCloseBlocked: True if gripper closing is in collision or at its lower limit.
     */
    public updateGripperLimitState(
        isOpenBlocked: boolean,
        isCloseBlocked: boolean,
    ): void {
        if (
            (isOpenBlocked &&
                this.activeFlyingButton === FlyingGripperButton.GripperOpen) ||
            (isCloseBlocked &&
                this.activeFlyingButton === FlyingGripperButton.GripperClose)
        ) {
            this.stopCurrentAction(true);
        }
    }

    /**
     * Move the gripper in task-space / camera frame for durationMs then stop.
     *
     * Args:
     *     button: Directional translation button.
     *     durationMs: How long to apply task-space velocity (defaults to 1000ms).
     *     speedMultiplier: PROFILE_SCALES entry for the speed the command named; the
     *         interface's speedometer does not apply to voice moves, so this is the only scaling.
     *
     * Returns:
     *     False if no robot is attached or button is not a translation, true otherwise.
     */
    public timedFlyingMove(
        button: FlyingGripperButton,
        durationMs: number = 1000,
        speedMultiplier: number = 1.0,
    ): boolean {
        if (!FunctionProvider.remoteRobot) {
            return false;
        }

        const translation = TRANSLATION[button];
        if (!translation) {
            return false;
        }

        const linScale = TASK_SPACE_LINEAR_VEL * speedMultiplier;
        const [x, y, z] = translation;

        FunctionProvider.stopAllActions(true);
        this.continuousTaskSpaceMovement(
            x * linScale,
            y * linScale,
            z * linScale,
        );
        this.timedVoiceMoveActive = true;
        this.activeFlyingButton = button;

        this.timedVoiceMoveTimer = setTimeout(() => {
            this.timedVoiceMoveTimer = undefined;
            this.timedVoiceMoveActive = false;
            this.stopCurrentAction(true);
        }, durationMs);

        return true;
    }

    /**
     * Returns pointer event callbacks for a flying gripper button according to the active action mode.
     *
     * Args:
     *     button: The flying gripper button to bind.
     *
     * Returns:
     *     The {@link ButtonFunctions} for the given button.
     */
    public provideFunctions(
        button: FlyingGripperButton,
    ): ButtonFunctions {
        const onLeave = () => {
            this.stopCurrentAction(true);
        };

        const translation = TRANSLATION[button];
        const gripperSign = button === FlyingGripperButton.GripperClose ? -1 : 1;
        const gripperVelocity =
            gripperSign * (FunctionProvider.jointVelocity(GRIPPER_JOINT) ?? 0.1);
        const gripperIncrement =
            gripperSign *
            (JOINT_INCREMENTS[GRIPPER_JOINT] ?? 0.1) *
            FunctionProvider.velocityScale;
        const linScale = TASK_SPACE_LINEAR_VEL * FunctionProvider.velocityScale;

        const startAction = () => {
            if (translation) {
                const [x, y, z] = translation;
                this.continuousTaskSpaceMovement(
                    x * linScale,
                    y * linScale,
                    z * linScale,
                );
                return;
            }
            this.continuousJointMovement(GRIPPER_JOINT, gripperVelocity);
        };

        switch (FunctionProvider.actionMode) {
            case ActionModeType.StepActions:
                return {
                    onClick: () => {
                        if (translation) {
                            startAction();
                            setTimeout(() => {
                                this.stopCurrentAction(true);
                            }, 1000);
                        } else {
                            this.incrementalJointMove(
                                GRIPPER_JOINT,
                                gripperIncrement,
                            );
                        }
                        this.activeFlyingButton = button;
                    },
                };
            case ActionModeType.PressAndHold:
                return {
                    onClick: () => {
                        startAction();
                        this.activeFlyingButton = button;
                    },
                    onRelease: () => {
                        this.stopCurrentAction(true);
                    },
                    onLeave,
                };
            case ActionModeType.ClickClick:
                return {
                    onClick: () => {
                        if (!this.isVelocityHeartbeatActive()) {
                            startAction();
                            this.activeFlyingButton = button;
                        } else if (this.activeFlyingButton === button) {
                            this.stopCurrentAction(true);
                        } else {
                            this.stopCurrentAction(true);
                            startAction();
                            this.activeFlyingButton = button;
                        }
                    },
                };
        }
    }
}
