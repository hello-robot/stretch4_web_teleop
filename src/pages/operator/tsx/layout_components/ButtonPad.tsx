import "operator/css/ButtonPad.css";
import armDownIcon from "operator/icons/ArmDown.svg";
import armExtendIcon from "operator/icons/ArmExtend.svg";
import armRetractIcon from "operator/icons/ArmRetract.svg";
import armUpIcon from "operator/icons/ArmUp.svg";
import chevronIcon from "operator/icons/Chevron.svg";
import gripperCloseIcon from "operator/icons/GripperClose.svg";
import gripperOpenIcon from "operator/icons/GripperOpen.svg";
import rotateLeftIcon from "operator/icons/RotateLeft.svg";
import rotateRightIcon from "operator/icons/RotateRight.svg";
import wristPitchDownIcon from "operator/icons/WristPitchDown.svg";
import wristPitchUpIcon from "operator/icons/WristPitchUp.svg";
import wristRollLeftIcon from "operator/icons/WristRollLeft.svg";
import wristRollRightIcon from "operator/icons/WristRollRight.svg";
import wristYawLeftIcon from "operator/icons/WristYawLeft.svg";
import wristYawRightIcon from "operator/icons/WristYawRight.svg";
import { buttonFunctionProvider } from "operator/tsx/index";
import React from "react";
import { isMobile } from "react-device-detect";
import { className, ToolMetadata } from "shared/util";
import {
    ButtonFunctions,
    ButtonPadButton,
    ButtonState,
} from "../function_providers/ButtonFunctionProvider";
import DirectionalPad from "../static_components/DirectionalPad";
import {
    ButtonPadDefinition,
    ButtonPadId,
    ButtonPadIdMobile,
    PilotButtonPadType,
} from "../utils/component_definitions";
import {
    ButtonPadShape,
    getIcon,
    getPathsFromShape,
    SVG_RESOLUTION,
} from "../utils/svg";
import {
    CustomizableComponentProps,
    isSelected,
    SharedState,
} from "./CustomizableComponent";

/** Properties for {@link ButtonPad} */
type ButtonPadProps = CustomizableComponentProps & {
    /* If the button pad is overlaid on a camera view. */
    overlay?: boolean;
    /* Aspect ratio of the button pad */
    aspectRatio?: number;
    isCameraVeilVisible: boolean;
    pilotControlsCurrent: PilotButtonPadType;
};

/** Set of buttons which are disabled when the robot is not homed. */
const notHomedDisabledFunctions = new Set<ButtonPadButton>([
    ButtonPadButton.ArmLower,
    ButtonPadButton.ArmLift,
    ButtonPadButton.ArmExtend,
    ButtonPadButton.ArmRetract,
    ButtonPadButton.WristRotateIn,
    ButtonPadButton.WristRotateOut,
    ButtonPadButton.GripperOpen,
    ButtonPadButton.GripperClose,
]);

/** Helper function to get the appropriate rotate icon based on pilot controls and direction */
const getRotateIcon = (
    pilotControlsCurrent: string,
    direction: string
): string => {
    const isArmGripper = pilotControlsCurrent === PilotButtonPadType.ArmGripper;
    const isWrist = pilotControlsCurrent === PilotButtonPadType.Wrist;
    if (direction === "rotate-left") {
        return isArmGripper ? armUpIcon : isWrist ? wristRollLeftIcon : rotateLeftIcon;
    } else {
        return isArmGripper ? armDownIcon : isWrist ? wristRollRightIcon : rotateRightIcon;
    }
};

/**
 * A set of buttons which can be overlaid as a child of a camera view or
 * standalone.
 *
 * TODO: Probably good idea to extract this
 * to dedicated React component for moving
 * the robot base
 *
 * <ButtonPad> 👉 <DirectionalPad>
 * @param props {@link ButtonPadProps}
 */
export const ButtonPad = (props: ButtonPadProps): React.JSX.Element => {
    /** Reference to the SVG which makes up the button pad */
    const svgRef = React.useRef<SVGSVGElement>(null);
    /** List of path shapes for each button on the button pad */
    const definition = props.definition as ButtonPadDefinition;
    const id: ButtonPadId | ButtonPadIdMobile = definition.id;

    if (!id) throw Error("Undefined button pad ID at path " + props.path);

    const [shape, functions] = getShapeAndFunctionsFromId(definition.id);
    const [paths, iconPositions] = getPathsFromShape(shape, props.aspectRatio);

    // Paths and functions should be the same length
    if (paths.length !== functions.length) {
        throw Error(
            `paths length: ${paths.length}, functions length: ${functions.length}`
        );
    }

    const pilotControlsCurrent = props.pilotControlsCurrent;
    const { customizing } = props.sharedState;
    const { overlay } = props;
    const selected = isSelected(props);

    /** Uses the paths and buttonsProps to create the buttons */
    function mapPaths(svgPath: string, i: number) {
        const buttonProps = {
            iconPosition: iconPositions[i],
            svgPath,
            funct: functions[i],
            sharedState: props.sharedState,
        };
        // Buttons will not function during customization mode
        return <SingleButton {...buttonProps} key={i} />;
    }

    /** Callback when SVG is clicked during customize mode */
    const onSelect = (event: React.MouseEvent<SVGSVGElement>) => {
        // Make sure the container of the button pad doesn't get selected
        event.stopPropagation();
        props.sharedState.onSelect(props.definition, props.path);
    };

    // In customizing state add onClick callback to button pad SVG element
    // note: if overlaid on a video stream, let the parent video stream handle the click
    const selectProp =
        customizing && !overlay
            ? {
                onClick: onSelect,
            }
            : {};

    /**
     * Maps a direction to a button function based on the current pilot controls mode
     */
    const getButtonFunctionForDirection = (
        direction: string
    ): ButtonPadButton => {
        const B = ButtonPadButton;

        // BaseDrive mode (default)
        if (pilotControlsCurrent === PilotButtonPadType.BaseDrive) {
            switch (direction) {
                case "north":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.OmniForward
                        : B.BaseForward;
                case "south":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.OmniBackward
                        : B.BaseReverse;
                case "west":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.StrafeLeft
                        : B.BaseForward; // Fallback for Drive (shouldn't happen)
                case "east":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.StrafeRight
                        : B.BaseReverse; // Fallback for Drive (shouldn't happen)
                case "rotate-left":
                    return B.BaseRotateLeft;
                case "rotate-right":
                    return B.BaseRotateRight;
                default:
                    return functions[0]; // Fallback
            }
        }
        // ArmGripper mode
        else if (pilotControlsCurrent === PilotButtonPadType.ArmGripper) {
            switch (direction) {
                case "north":
                    return B.ArmExtend;
                case "south":
                    return B.ArmRetract;
                case "west":
                    return B.GripperOpen;
                case "east":
                    return B.GripperClose;
                case "rotate-left":
                    return B.ArmLift;
                case "rotate-right":
                    return B.ArmLower;
                default:
                    return functions[0]; // Fallback
            }
        }
        // Wrist mode
        else if (pilotControlsCurrent === PilotButtonPadType.Wrist) {
            switch (direction) {
                case "north":
                    return B.WristPitchUp;
                case "south":
                    return B.WristPitchDown;
                case "west":
                    return B.WristRotateIn; // yaw right
                case "east":
                    return B.WristRotateOut; // yaw left
                case "rotate-left":
                    return B.WristRollLeft; // counter-clockwise
                case "rotate-right":
                    return B.WristRollRight; // clockwise
                default:
                    return functions[0]; // Fallback
            }
        }
        // Default to BaseDrive if mode is unknown
        else {
            switch (direction) {
                case "north":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.OmniForward
                        : B.BaseForward;
                case "south":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.OmniBackward
                        : B.BaseReverse;
                case "west":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.StrafeLeft
                        : B.BaseForward;
                case "east":
                    return definition.id === ButtonPadIdMobile.OmniDrive
                        ? B.StrafeRight
                        : B.BaseReverse;
                case "rotate-left":
                    return B.BaseRotateLeft;
                case "rotate-right":
                    return B.BaseRotateRight;
                default:
                    return functions[0]; // Fallback
            }
        }
    };

    const mapButtons = (direction: string, i: number) => {
        const buttonProps = {
            direction,
            funct: getButtonFunctionForDirection(direction),
            sharedState: props.sharedState,
            isCameraVeilVisible: props.isCameraVeilVisible,
            pilotControlsCurrent: pilotControlsCurrent,
        };
        return <DirectionalButton {...buttonProps} key={i} />;
    };

    if (
        definition.id === ButtonPadIdMobile.Drive ||
        definition.id === ButtonPadIdMobile.OmniDrive
    ) {
        return (
            <DirectionalPad
                mapButtons={mapButtons}
                isCameraVeilVisible={props.isCameraVeilVisible}
            />
        );
    } else
        return (
            <div className="button-pad">
                <svg
                    ref={svgRef}
                    viewBox={`0 0 ${SVG_RESOLUTION} ${props.aspectRatio
                        ? SVG_RESOLUTION / props.aspectRatio
                        : SVG_RESOLUTION
                        }`}
                    preserveAspectRatio="none"
                    className={className("button-pads", {
                        customizing,
                        selected,
                        overlay,
                    })}
                    {...selectProp}
                >
                    {paths.map(mapPaths)}
                </svg>
            </div>
        );
};

/** Properties for a single button on a button pad */
export type DirectionalButtonProps = {
    direction: string;
    funct: ButtonPadButton;
    sharedState: SharedState;
    isCameraVeilVisible?: boolean;
    pilotControlsCurrent: string;
};

/**
 * A single button on a button pad
 *
 * @param props {@link DirectionalButtonProps}
 */
const DirectionalButton = (props: DirectionalButtonProps) => {
    const functs: ButtonFunctions = buttonFunctionProvider.provideFunctions(
        props.funct
    );
    const disabledDueToNotHomed =
        !props.sharedState.robotIsHomed &&
        notHomedDisabledFunctions.has(props.funct);
    const isGripperBtn = props.funct === ButtonPadButton.GripperOpen || props.funct === ButtonPadButton.GripperClose;
    const toolMetadata: ToolMetadata | undefined = props.sharedState.toolMetadata;
    const gripperDisabled = isGripperBtn && toolMetadata?.isActuated === false;

    const isDisabled = props.sharedState.customizing || disabledDueToNotHomed || gripperDisabled;

    const clickProps = isDisabled
        ? {}
        : {
            onPointerDown: functs.onClick,
            onPointerUp: functs.onRelease,
            onPointerCancel: functs.onRelease,
            onPointerLeave: functs.onLeave,
        };

    const buttonState: ButtonState =
        props.sharedState.buttonStateMap?.get(props.funct) ||
        ButtonState.Inactive;
    const cardinalDirections = ["north", "south", "west", "east"];
    const rotateDirections = ["rotate-left", "rotate-right"];
    const getAriaLabel = (direction: string): string => {
        const pilotControlsCurrent = props.pilotControlsCurrent;

        // BaseDrive mode (default)
        if (pilotControlsCurrent === PilotButtonPadType.BaseDrive) {
            switch (direction) {
                case "north":
                    return "Move forward";
                case "south":
                    return "Move backward";
                case "west":
                    return "Strafe left";
                case "east":
                    return "Strafe right";
                case "rotate-left":
                    return "Turn left";
                case "rotate-right":
                    return "Turn right";
                default:
                    console.warn(`Unknown direction: ${direction}`);
                    return "Unknown action";
            }
        }
        // ArmGripper mode
        else if (pilotControlsCurrent === PilotButtonPadType.ArmGripper) {
            switch (direction) {
                case "north":
                    return "Extend arm";
                case "south":
                    return "Retract arm";
                case "west":
                    return "Open gripper";
                case "east":
                    return "Close gripper";
                case "rotate-left":
                    return "Raise arm";
                case "rotate-right":
                    return "Lower arm";
                default:
                    console.warn(`Unknown direction: ${direction}`);
                    return "Unknown action";
            }
        }
        // Wrist mode
        else if (pilotControlsCurrent === PilotButtonPadType.Wrist) {
            switch (direction) {
                case "north":
                    return "Pitch wrist up";
                case "south":
                    return "Pitch wrist down";
                case "west":
                    return "Yaw wrist left";
                case "east":
                    return "Yaw wrist right";
                case "rotate-left":
                    return "Rotate wrist counter-clockwise";
                case "rotate-right":
                    return "Rotate wrist clockwise";
                default:
                    console.warn(`Unknown direction: ${direction}`);
                    return "Unknown action";
            }
        }
        // Default to BaseDrive labels
        else {
            switch (direction) {
                case "north":
                    return "Move forward";
                case "south":
                    return "Move backward";
                case "west":
                    return "Strafe left";
                case "east":
                    return "Strafe right";
                case "rotate-left":
                    return "Turn left";
                case "rotate-right":
                    return "Turn right";
                default:
                    console.warn(`Unknown direction: ${direction}`);
                    return "Unknown action";
            }
        }
    };
    const ariaLabel = getAriaLabel(props.direction);
    const pilotControlsCurrent = props.pilotControlsCurrent;
    const isArmGripperButtons = pilotControlsCurrent === PilotButtonPadType.ArmGripper;
    const isWristButtons = pilotControlsCurrent === PilotButtonPadType.Wrist;
    const isChevronButtons = !isArmGripperButtons && !isWristButtons && cardinalDirections.includes(props.direction);
    const isRotate = rotateDirections.includes(props.direction);
    const armGripperIconCalc = (direction: string): string => {
        switch (direction) {
            case "north":
                return armExtendIcon;
            case "south":
                return armRetractIcon;
            case "west":
                return gripperOpenIcon;
            case "east":
                return gripperCloseIcon;
            default:
                return chevronIcon;
        }
    }

    const wristIconCalc = (direction: string): string => {
        switch (direction) {
            case "north":
                return wristPitchUpIcon;
            case "south":
                return wristPitchDownIcon;
            case "west":
                return wristYawLeftIcon;
            case "east":
                return wristYawRightIcon;
            default:
                return chevronIcon;
        }
    }

    // Base drive
    if (isRotate) {
        return (
            <div
                className={`button-turn-wrapper ${props.direction} ${buttonState}`}
                key={props.direction}
                role="none"
                {...clickProps}
            >
                {/* Used to prevent clicking with cursor device */}
                <div className="click-block" />
                <button
                    className={`${pilotControlsCurrent} button-turn ${props.direction} ${buttonState}`}
                    disabled={isDisabled}
                    aria-label={ariaLabel}
                    type="button"
                    tabIndex={0}
                    {...clickProps}
                >
                    <img
                        src={getRotateIcon(pilotControlsCurrent, props.direction)}
                        alt=""
                        className="turn-icon"
                        aria-hidden="true"
                    />
                    {/* Adding arbitrary text inside <span/> changes the position of iOS voice control labels */}
                    <span className="aria-inviz" aria-hidden="true"></span>
                </button>
            </div>
        );
    } else if (isChevronButtons) {
        return (
            <div
                className={`button-wrapper ${props.direction} ${buttonState}`}
                key={props.direction}
                role="none"
                {...clickProps}
            >
                <div className={`button-cardinal ${buttonState}`}>
                    <span className="synthetic-bottom-border"></span>
                </div>
                <button
                    type="button"
                    className={`button-chevron ${buttonState}`}
                    aria-label={ariaLabel}
                    tabIndex={0}
                    disabled={isDisabled}
                    {...clickProps}
                >
                    <img
                        src={chevronIcon}
                        alt=""
                        className="chevron-icon"
                        aria-hidden="true"
                    />
                    {/* Adding arbitrary text inside <span/> changes the position of iOS voice control labels */}
                    <span className="aria-inviz" aria-hidden="true">••</span>
                </button>
            </div>
        );
        // Both of the buttons in the center of dpad

        // Arm + Hand
    } else if (isArmGripperButtons) {
        return (
            <div
                className={`button-wrapper ${props.direction} ${buttonState}`}
                key={props.direction}
                role="none"
                {...clickProps}
            >
                <div className={`button-cardinal ${buttonState}`}>
                    <span className="synthetic-bottom-border"></span>
                </div>
                <button
                    type="button"
                    className={`button-arm-gripper ${buttonState}`}
                    aria-label={ariaLabel}
                    tabIndex={0}
                    disabled={isDisabled}
                    {...clickProps}
                >
                    <img
                        src={armGripperIconCalc(props.direction)}
                        alt=""
                        aria-hidden="true"
                    />
                    {/* Adding arbitrary text inside <span/> changes the position of iOS voice control labels */}
                    <span className="aria-inviz">••</span>
                </button>
            </div>
        );
        // Both of the buttons in the center of dpad
    } else if (isWristButtons) {
        return (
            <div
                className={`button-wrapper ${props.direction} ${buttonState}`}
                key={props.direction}
                role="none"
                {...clickProps}
            >
                <div className={`button-cardinal ${buttonState}`}>
                    <span className="synthetic-bottom-border"></span>
                </div>
                <button
                    type="button"
                    className={`button-wrist ${buttonState}`}
                    aria-label={ariaLabel}
                    tabIndex={0}
                    disabled={isDisabled}
                    {...clickProps}
                >
                    <img
                        src={wristIconCalc(props.direction)}
                        alt=""
                        aria-hidden="true"
                    />
                    {/* Adding arbitrary text inside <span/> changes the position of iOS voice control labels */}
                    <span className="aria-inviz">••</span>
                </button>
            </div>
        );
    }
};

/** Properties for a single button on a button pad */
export type SingleButtonProps = {
    svgPath: string;
    funct: ButtonPadButton;
    sharedState: SharedState;
    iconPosition: { x: number; y: number };
};

/**
 * A single button on a button pad
 *
 * @param props {@link SingleButtonProps}
 */
const SingleButton = (props: SingleButtonProps) => {
    const functs: ButtonFunctions = buttonFunctionProvider.provideFunctions(
        props.funct
    );
    const disabledDueToNotHomed =
        !props.sharedState.robotIsHomed &&
        notHomedDisabledFunctions.has(props.funct);
    const isGripperBtn = props.funct === ButtonPadButton.GripperOpen || props.funct === ButtonPadButton.GripperClose;
    const toolMetadata: ToolMetadata | undefined = props.sharedState.toolMetadata;
    const gripperDisabled = isGripperBtn && toolMetadata?.isActuated === false;

    const isDisabled = props.sharedState.customizing || disabledDueToNotHomed || gripperDisabled;

    const clickProps = isDisabled
        ? {}
        : {
            onMouseDown: functs.onClick,
            onMouseUp: functs.onRelease,
            onMouseLeave: functs.onLeave,
        };
    const buttonState: ButtonState =
        props.sharedState.buttonStateMap?.get(props.funct) ||
        ButtonState.Inactive;
    const icon = getIcon(props.funct);
    const title = props.funct;
    const height = isMobile ? 75 : 85;
    const width = isMobile ? 75 : 85;
    const x = props.iconPosition.x - width / 2;
    const y = props.iconPosition.y - height / 2;

    return (
        <React.Fragment>
            <path
                d={props.svgPath}
                {...clickProps}
                className={className(buttonState, {
                    disable: isDisabled,
                })}
            >
                <title>{title}</title>
            </path>
            <image
                x={x}
                y={y}
                height={height}
                width={width}
                href={icon}
                className={className(buttonState, {
                    disable: isDisabled,
                })}
            />
            <p>{title}</p>
        </React.Fragment>
    );
};

/**
 * Provides the shape and functions for a button pad based on the identifier
 *
 * @param id the identifier of the button pad
 * @returns the shape of the button pad {@link ButtonPadShape} and a list of
 * {@link ButtonPadButton} where each element informs the function of
 * the corresponding button on the button pad
 */
function getShapeAndFunctionsFromId(
    id: ButtonPadId | ButtonPadIdMobile
): [ButtonPadShape, ButtonPadButton[]] {
    let shape: ButtonPadShape;
    let functions: ButtonPadButton[];
    const B = ButtonPadButton;
    switch (id) {
        case ButtonPadId.ManipRealsense:
            functions = [
                B.WristRotateIn,
                B.WristRotateOut,
                B.ArmExtend,
                B.ArmRetract,
                B.BaseForward,
                B.BaseReverse,
                B.ArmLift,
                B.ArmLower,
                B.GripperClose,
                B.GripperOpen,
            ];
            shape = ButtonPadShape.ManipRealsense;
            break;
        case ButtonPadId.GripperLift:
            functions = [
                B.ArmLift,
                B.ArmLower,
                B.WristRotateIn,
                B.WristRotateOut,
                B.GripperOpen,
                B.GripperClose,
            ];
            shape = ButtonPadShape.GripperLift;
            break;
        case ButtonPadId.DexWrist:
            functions = [
                B.WristPitchUp,
                B.WristPitchDown,
                B.WristRotateIn,
                B.WristRotateOut,
                B.WristRollLeft,
                B.WristRollRight,
                B.GripperOpen,
                B.GripperClose,
            ];
            shape = ButtonPadShape.DexWrist;
            break;
        case ButtonPadId.Base:
            functions = [
                B.BaseForward,
                B.BaseReverse,
                B.BaseRotateLeft,
                B.BaseRotateRight,
            ];
            shape = ButtonPadShape.SimpleButtonPad;
            break;
        case ButtonPadId.Arm:
            functions = [B.ArmLift, B.ArmLower, B.ArmRetract, B.ArmExtend];
            shape = ButtonPadShape.SimpleButtonPad;
            break;
        case ButtonPadIdMobile.Arm:
            functions = [B.ArmLift, B.ArmLower, B.ArmRetract, B.ArmExtend];
            shape = ButtonPadShape.RowButtonPad;
            break;
        case ButtonPadIdMobile.Gripper:
            functions = [
                B.WristRotateIn,
                B.WristRotateOut,
                B.GripperOpen,
                B.GripperClose,
            ];
            shape = ButtonPadShape.RowButtonPad;
            break;
        case ButtonPadIdMobile.Drive:
            functions = [
                B.BaseForward,
                B.BaseReverse,
                B.BaseRotateLeft,
                B.BaseRotateRight,
            ];
            shape = ButtonPadShape.RowButtonPad;
            break;
        case ButtonPadIdMobile.OmniDrive:
            functions = [
                B.OmniForward,
                B.OmniBackward,
                B.StrafeLeft,
                B.StrafeRight,
                B.BaseRotateLeft,
                B.BaseRotateRight,
            ];
            shape = ButtonPadShape.GripperLift; // To Do: temp to remove error
            break;
        default:
            throw new Error(`unknow button pad id: ${id}`);
    }

    return [shape, functions];
}
