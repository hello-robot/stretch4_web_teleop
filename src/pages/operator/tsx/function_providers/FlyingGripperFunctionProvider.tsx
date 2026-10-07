import {
    JOINT_INCREMENTS,
    JOINT_VELOCITIES,
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

const GRIPPER_JOINT = "stretch_gripper_joint" as const;

/**
 * Flying-gripper pad: six tool-frame translations plus gripper open/close.
 */
export class FlyingGripperFunctionProvider extends FunctionProvider {
    private activeFlyingButton?: FlyingGripperButton;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.disableActiveButton = this.disableActiveButton.bind(this);
    }

    public disableActiveButton() {
        this.stopCurrentAction(true);
        this.activeFlyingButton = undefined;
    }

    public provideFunctions(
        button: FlyingGripperButton,
    ): ButtonFunctions {
        const onLeave = () => {
            this.stopCurrentAction(true);
            this.activeFlyingButton = undefined;
        };

        const translation = TRANSLATION[button];
        const gripperSign = button === FlyingGripperButton.GripperClose ? -1 : 1;
        const gripperVelocity =
            gripperSign *
            (JOINT_VELOCITIES[GRIPPER_JOINT] ?? 0.1) *
            FunctionProvider.velocityScale;
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
                                this.activeFlyingButton = undefined;
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
                        this.activeFlyingButton = undefined;
                    },
                    onLeave,
                };
            case ActionModeType.ClickClick:
                return {
                    onClick: () => {
                        if (!this.activeVelocityAction) {
                            startAction();
                            this.activeFlyingButton = button;
                        } else if (this.activeFlyingButton === button) {
                            this.stopCurrentAction(true);
                            this.activeFlyingButton = undefined;
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
