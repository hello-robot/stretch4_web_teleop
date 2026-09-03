import {
    JOINT_VELOCITIES,
    JOINT_INCREMENTS,
    ValidJoints,
    ValidJointStateDict,
} from "shared/util";
import { ActionModeType } from "../utils/component_definitions";
import { FunctionProvider } from "./FunctionProvider";

/**
 * Each of the possible buttons which could be on a button pad. The string is
 * the label of the button which appears in the tooltip.
 */
export enum ButtonPadButton {
    OmniForward = "Omni Forward",
    OmniBackward = "Omni Backward",
    StrafeLeft = "Strafe Left",
    StrafeRight = "Strafe Right",
    BaseForward = "Base Forward",
    BaseReverse = "Base Reverse",
    BaseRotateRight = "Base rotate right",
    BaseRotateLeft = "Base rotate left",
    ArmLift = "Arm lift",
    ArmLower = "Arm lower",
    ArmExtend = "Arm extend",
    ArmRetract = "Arm retract",
    GripperOpen = "Gripper open",
    GripperClose = "Gripper close",
    WristRotateIn = "Wrist rotate in",
    WristRotateOut = "Wrist rotate out",
    WristPitchUp = "Wrist pitch up",
    WristPitchDown = "Wrist pitch down",
    WristRollLeft = "Wrist roll left",
    WristRollRight = "Wrist roll right",
}

/** Button functions which require moving a joint in the negative direction. */
const negativeButtonPadFunctions = new Set<ButtonPadButton>([
    ButtonPadButton.OmniBackward,
    ButtonPadButton.StrafeRight,
    ButtonPadButton.BaseReverse,
    ButtonPadButton.BaseRotateRight,
    ButtonPadButton.ArmLower,
    ButtonPadButton.ArmRetract,
    ButtonPadButton.GripperClose,
    ButtonPadButton.WristRotateOut,
    ButtonPadButton.WristPitchUp,
    ButtonPadButton.WristRollLeft,
]);

/** Functions called when the user interacts with a button. */
export type ButtonFunctions = {
    onClick: () => void;
    onRelease?: () => void;
    onLeave?: () => void;
};

/** State for a single button on a button pad. */
export enum ButtonState {
    Inactive = "inactive",
    Active = "active",
    Collision = "collision",
    Limit = "limit",
}

/** Mapping from each type of button pad button to the state for that button */
export type ButtonStateMap = Map<ButtonPadButton, ButtonState>;

/**
 * Provides functions for the button pads
 */
export class ButtonFunctionProvider extends FunctionProvider {
    private buttonStateMap: ButtonStateMap = new Map<
        ButtonPadButton,
        ButtonState
    >();

    /**
     * Callback function to update the button state map in the operator so it
     * can rerender the button pads.
     */
    private operatorCallback?: (buttonStateMap: ButtonStateMap) => void =
        undefined;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.updateJointStates = this.updateJointStates.bind(this);
        this.setButtonActiveState = this.setButtonActiveState.bind(this);
        this.setButtonInactiveState = this.setButtonInactiveState.bind(this);
    }

    /**
     * Takes joint states and updates the button state map based on which joints
     * are in collision or at their limit.
     *
     * @param inJointLimit dictionary of joints whose limit booleans have changed
     * @param inCollision dictionary of joints whose collision booleans have changed
     */
    public updateJointStates(
        inJointLimit: ValidJointStateDict,
        inCollision: ValidJointStateDict
    ) {
        const allJointKeys = Array.from(
            new Set([...Object.keys(inCollision), ...Object.keys(inJointLimit)])
        ) as ValidJoints[];

        const targetButtonStates = new Map<ButtonPadButton, ButtonState>();

        allJointKeys.forEach((key) => {
            const buttons = getButtonsFromJointName(key);
            if (!buttons) return;

            const [buttonNeg, buttonPos] = buttons;
            const collisionTuple = inCollision[key];
            const limitTuple = inJointLimit[key];

            const [inCollisionNeg, inCollisionPos] = collisionTuple || [];
            const [inLimitNeg, inLimitPos] = limitTuple || [];

            const updateTargetState = (
                btn: ButtonPadButton,
                isCollision?: boolean,
                isWithinLimit?: boolean
            ) => {
                const currentTarget = targetButtonStates.get(btn) || ButtonState.Inactive;

                if (isCollision === true) {
                    targetButtonStates.set(btn, ButtonState.Collision);
                } else if (isWithinLimit === false && currentTarget !== ButtonState.Collision) {
                    targetButtonStates.set(btn, ButtonState.Limit);
                }
            };

            updateTargetState(buttonNeg, inCollisionNeg, inLimitNeg);
            updateTargetState(buttonPos, inCollisionPos, inLimitPos);
        });

        const buttonsToUpdate = new Set([
            ...Array.from(targetButtonStates.keys()),
            ...Array.from(this.buttonStateMap.keys()).filter(k =>
                this.buttonStateMap.get(k) === ButtonState.Collision ||
                this.buttonStateMap.get(k) === ButtonState.Limit
            )
        ]);

        buttonsToUpdate.forEach(btn => {
            const targetState = targetButtonStates.get(btn) || ButtonState.Inactive;
            const currentState = this.buttonStateMap.get(btn) || ButtonState.Inactive;

            if (targetState === ButtonState.Collision || targetState === ButtonState.Limit) {
                if (currentState !== targetState) {
                    console.log(`[ButtonProvider] Setting ${btn} to state: ${targetState}`);
                    this.buttonStateMap.set(btn, targetState);
                }
            } else {
                if (currentState === ButtonState.Collision || currentState === ButtonState.Limit) {
                    this.buttonStateMap.set(btn, ButtonState.Inactive);
                }
            }
        });

        if (this.operatorCallback) this.operatorCallback(this.buttonStateMap);
    }

    /**
     * Sets the local pointer to the operator's callback function, to be called
     * whenever the button state map updates.
     *
     * @param callback operator's callback function to update the button state map
     */
    public setOperatorCallback(
        callback: (buttonStateMap: ButtonStateMap) => void
    ) {
        this.operatorCallback = callback;
    }

    /**
     * Sets a type of a button pad button to active.
     *
     * @param buttonType the button pad button to set active
     */
    private setButtonActiveState(buttonType: ButtonPadButton) {
        const currentState = this.buttonStateMap.get(buttonType);

        // Don't set to active if in collision or at it's limit
        if (
            currentState === ButtonState.Collision ||
            currentState === ButtonState.Limit
        )
            return;

        this.buttonStateMap.set(buttonType, ButtonState.Active);
        if (this.operatorCallback) this.operatorCallback(this.buttonStateMap);
    }

    /**
     * Sets a type of a button pad button to inactive.
     *
     * @param buttonType the button pad button to set active
     */
    private setButtonInactiveState(buttonType: ButtonPadButton) {
        const currentState = this.buttonStateMap.get(buttonType);

        // Don't set to inactive if in collision or at it's limit
        if (
            currentState === ButtonState.Collision ||
            currentState === ButtonState.Limit ||
            currentState === ButtonState.Inactive
        )
            return;

        this.buttonStateMap.set(buttonType, ButtonState.Inactive);
        if (this.operatorCallback) this.operatorCallback(this.buttonStateMap);
    }

    //  TEMP FOR ACTION MODAL DISABILING
    public disableActiveButton() {
        this.stopCurrentAction(true);
        this.setButtonInactiveState(this.activeButtonPadFunction);
    }

    /**
     * Takes a ButtonPadFunction which indicates the type of button (e.g. drive
     * base forward, lift arm), and returns a set of functions to execute when
     * the user interacts with the button.
     *
     * @param buttonPadFunction the {@link ButtonPadButton}
     * @returns the {@link ButtonFunctions} for the button
     */
    public provideFunctions(
        buttonPadFunction: ButtonPadButton
    ): ButtonFunctions {
        let action: () => void;
        const onLeave = () => {
            this.stopCurrentAction(true);
            this.setButtonInactiveState(buttonPadFunction);
        };

        const jointName: ValidJoints =
            getJointNameFromButtonFunction(buttonPadFunction);
        const multiplier: number = negativeButtonPadFunctions.has(
            buttonPadFunction
        )
            ? -1
            : 1;
        const jointVelocity = JOINT_VELOCITIES[jointName];
        if (jointVelocity === undefined) {
            throw new Error(`ButtonFunctionProvider::provideFunctions: Velocity for joint ${jointName} is undefined!`);
        }
        const velocity =
            multiplier * jointVelocity * FunctionProvider.velocityScale;

        const jointIncrement = JOINT_INCREMENTS[jointName];
        if (jointIncrement === undefined) {
            throw new Error(`ButtonFunctionProvider::provideFunctions: Increment for joint ${jointName} is undefined!`);
        }
        const increment =
            multiplier * jointIncrement * FunctionProvider.velocityScale;

        switch (FunctionProvider.actionMode) {
            case ActionModeType.StepActions:
                switch (buttonPadFunction) {
                    case ButtonPadButton.OmniForward:
                    case ButtonPadButton.OmniBackward:
                    case ButtonPadButton.BaseForward:
                    case ButtonPadButton.BaseReverse:
                        action = () => this.setBaseVelocity(velocity, 0.0, 0.0);
                        break;
                    case ButtonPadButton.StrafeLeft:
                    case ButtonPadButton.StrafeRight:
                        action = () => this.setBaseVelocity(0.0, velocity, 0.0);
                        break;
                    case ButtonPadButton.BaseRotateLeft:
                    case ButtonPadButton.BaseRotateRight:
                        action = () => this.setBaseVelocity(0.0, 0.0, velocity);
                        break;
                    case ButtonPadButton.ArmLower:
                    case ButtonPadButton.ArmLift:
                    case ButtonPadButton.ArmExtend:
                    case ButtonPadButton.ArmRetract:
                    case ButtonPadButton.WristRotateIn:
                    case ButtonPadButton.WristRotateOut:
                    case ButtonPadButton.WristPitchUp:
                    case ButtonPadButton.WristPitchDown:
                    case ButtonPadButton.WristRollLeft:
                    case ButtonPadButton.WristRollRight:
                    case ButtonPadButton.GripperOpen:
                    case ButtonPadButton.GripperClose:
                        action = () =>
                            this.incrementalJointMove(jointName, increment);
                        break;
                }
                return {
                    onClick: () => {
                        action();
                        this.setButtonActiveState(buttonPadFunction);
                        // Set button state inactive after 1 second
                        setTimeout(() => {
                            this.setButtonInactiveState(buttonPadFunction);
                            this.setBaseVelocity(0.0, 0.0, 0.0);
                        }, 1000);
                    },
                    // onLeave: onLeave,
                };
            case ActionModeType.PressAndHold:
            case ActionModeType.ClickClick:
                switch (buttonPadFunction) {
                    case ButtonPadButton.OmniForward:
                    case ButtonPadButton.OmniBackward:
                    case ButtonPadButton.BaseForward:
                    case ButtonPadButton.BaseReverse:
                        action = () => this.setBaseVelocity(velocity, 0.0, 0.0);
                        break;
                    case ButtonPadButton.StrafeLeft:
                    case ButtonPadButton.StrafeRight:
                        action = () => this.setBaseVelocity(0.0, velocity, 0.0);
                        break;
                    case ButtonPadButton.BaseRotateLeft:
                    case ButtonPadButton.BaseRotateRight:
                        action = () => this.setBaseVelocity(0.0, 0.0, velocity);
                        break;

                    case ButtonPadButton.ArmLower:
                    case ButtonPadButton.ArmLift:
                    case ButtonPadButton.ArmExtend:
                    case ButtonPadButton.ArmRetract:
                    case ButtonPadButton.WristRotateIn:
                    case ButtonPadButton.WristRotateOut:
                    case ButtonPadButton.WristPitchUp:
                    case ButtonPadButton.WristPitchDown:
                    case ButtonPadButton.WristRollLeft:
                    case ButtonPadButton.WristRollRight:
                    case ButtonPadButton.GripperOpen:
                    case ButtonPadButton.GripperClose:
                        action = () =>
                            this.continuousJointMovement(jointName, velocity);
                        break;
                }

                return FunctionProvider.actionMode ===
                    ActionModeType.PressAndHold
                    ? {
                        onClick: () => {
                            action();
                            this.setButtonActiveState(buttonPadFunction);
                        },
                        // For press-release, stop when button released
                        onRelease: () => {
                            this.stopCurrentAction(true);
                            this.setButtonInactiveState(buttonPadFunction);
                        },
                        onLeave: onLeave,
                    }
                    : {
                        // For click-click, stop if button already active
                        onClick: () => {
                            // If the robot is not moving, start moving and set button to active
                            if (!this.activeVelocityAction) {
                                action();
                                this.activeButtonPadFunction =
                                    buttonPadFunction;
                                this.setButtonActiveState(
                                    this.activeButtonPadFunction
                                );
                            }

                            // If the robot is moving, and same button pressed
                            // stop and set the button to inactive
                            else if (
                                this.activeButtonPadFunction ==
                                buttonPadFunction &&
                                this.activeVelocityAction
                            ) {
                                this.stopCurrentAction(true);
                                this.setButtonInactiveState(
                                    this.activeButtonPadFunction
                                );
                                this.activeButtonPadFunction = undefined;
                            }

                            // The button pressed is not the active button, stop current action
                            //  and execute the new function
                            else if (
                                this.activeButtonPadFunction !==
                                buttonPadFunction &&
                                this.activeVelocityAction
                            ) {
                                this.stopCurrentAction(true);
                                this.setButtonInactiveState(
                                    this.activeButtonPadFunction
                                );

                                action();
                                this.activeButtonPadFunction =
                                    buttonPadFunction;
                                this.setButtonActiveState(
                                    this.activeButtonPadFunction
                                );
                            }
                        },
                        // onLeave: onLeave,
                    };
        }
    }
}

/**
 * Uses the name of a joint on the robot to get the two related button pad buttons.
 *
 * @param jointName the name of the joint
 * @returns both of the corresponding button types (for moving the joint in the
 * negative or positive direction respectively)
 */
function getButtonsFromJointName(
    jointName: ValidJoints
): [ButtonPadButton, ButtonPadButton] | undefined {
    switch (jointName) {
        case "gripper_joint":
            return [ButtonPadButton.GripperClose, ButtonPadButton.GripperOpen];
        case "arm_joint":
        case "wrist_extension":
            return [ButtonPadButton.ArmRetract, ButtonPadButton.ArmExtend];
        case "lift_joint":
            return [ButtonPadButton.ArmLower, ButtonPadButton.ArmLift];
        case "wrist_roll_joint":
            return [
                ButtonPadButton.WristRollLeft,
                ButtonPadButton.WristRollRight,
            ];
        case "wrist_pitch_joint":
            return [
                ButtonPadButton.WristPitchUp,
                ButtonPadButton.WristPitchDown,
            ];
        case "wrist_yaw_joint":
            return [
                ButtonPadButton.WristRotateOut,
                ButtonPadButton.WristRotateIn,
            ];
        case "translate_mobile_base":
            return [ButtonPadButton.BaseReverse, ButtonPadButton.BaseForward];
        case "rotate_mobile_base":
            return [
                ButtonPadButton.BaseRotateRight,
                ButtonPadButton.BaseRotateLeft,
            ];
        default:
            return undefined;
    }
}

/**
 * Uses the type of a button pad button to get the corresponding joint name.
 *
 * @param buttonType the type of button in a button pad
 * @returns the name of the corresponding joint
 */
function getJointNameFromButtonFunction(
    buttonType: ButtonPadButton
): ValidJoints {
    switch (buttonType) {
        case ButtonPadButton.OmniForward:
        case ButtonPadButton.OmniBackward:
        case ButtonPadButton.StrafeLeft:
        case ButtonPadButton.StrafeRight:
        case ButtonPadButton.BaseReverse:
        case ButtonPadButton.BaseForward:
            return "translate_mobile_base";

        case ButtonPadButton.BaseRotateLeft:
        case ButtonPadButton.BaseRotateRight:
            return "rotate_mobile_base";

        case ButtonPadButton.ArmLower:
        case ButtonPadButton.ArmLift:
            return "lift_joint";

        case ButtonPadButton.ArmRetract:
        case ButtonPadButton.ArmExtend:
            return "arm_joint";

        case ButtonPadButton.GripperClose:
        case ButtonPadButton.GripperOpen:
            return "gripper_joint";

        case ButtonPadButton.WristRollLeft:
        case ButtonPadButton.WristRollRight:
            return "wrist_roll_joint";

        case ButtonPadButton.WristPitchUp:
        case ButtonPadButton.WristPitchDown:
            return "wrist_pitch_joint";

        case ButtonPadButton.WristRotateIn:
        case ButtonPadButton.WristRotateOut:
            return "wrist_yaw_joint";

        default:
            throw Error("unknown button pad function" + buttonType);
    }
}
