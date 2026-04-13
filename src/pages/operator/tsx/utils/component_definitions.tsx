/**
 * @summary Definitions to describe different components to render
 */

/** Enumerator for the possible action modes */
export enum ActionModeType {
    StepActions = "Step Action",
    PressAndHold = "Press-Hold",
    ClickClick = "Tap-Tap",
}

/** Enumerator for the Pilot's ButtonPad types */
export enum PilotButtonPadType {
    BaseDrive = "Drive",
    ArmGripper = "Arm + Gripper",
    Wrist = "Wrist",
}

/**
 * High-level type of the component
 */
export enum ComponentType {
    Layout = "Layout",
    LayoutGrid = "Layout Grid",
    Panel = "Panel",
    SingleTab = "Tab",
    ButtonPad = "Button Pad",
    Map = "Map",
    RunStopButton = "Run Stop Button",
    BatteryGauge = "Battery Gauge",
    MovementRecorder = "Movement Recorder",
}

/**
 * ID for the video stream, one for each of the cameras
 */
export enum CameraViewId {
    overhead = "Overhead",
    realsense = "Realsense",
    gripper = "Gripper",
}

/**
 * ID for a button pad describes the shape and button functions of the button pad
 */
export enum ButtonPadId {
    // Drive = "Drive",
    Base = "Drive",
    Arm = "Arm & Lift",
    DexWrist = "Dex Wrist",
    GripperLift = "Gripper & Lift",
    ManipRealsense = "Drive/Arm/Gripper/Wrist",
    Camera = "Camera",
    // Wrist = "Wrist",
}

export enum ButtonPadIdMobile {
    Arm = "Arm Mobile",
    Gripper = "Gripper Mobile",
    Drive = "Drive Mobile",
    OmniDrive = "Omni Drive Mobile",
}

/**
 * Identifier for the subtype of the component
 * (e.g. which video stream camera, or which button pad)
 * @note any new components with ID fields should be added to this type
 */
export type ComponentId = CameraViewId | ButtonPadId | ButtonPadIdMobile;

/**
 * Definition for any interface component. Any video stream, button pad,
 * tabs, etc. definition will have these fields.
 */
export type ComponentDefinition = {
    /** Indicates the type of the component */
    type: ComponentType;
    /** Indicates the identifier for the sub-type of the component */
    id?: ComponentId;
};

/**
 * Definition for a button pad component
 */
export type ButtonPadDefinition = ComponentDefinition & {
    /** Indicates the shape and functions on the button pad*/
    id: ButtonPadId | ButtonPadIdMobile;
};

export type ParentComponentDefinition = ComponentDefinition & {
    children: ComponentDefinition[];
};

export type LayoutDefinition = ComponentDefinition & {
    displayMovementRecorder: boolean;
    displayLabels: boolean;
    actionMode: ActionModeType;
    children: LayoutGridDefinition[];
    pilotControlsCurrent: string;
};

export type LayoutGridDefinition = ComponentDefinition & {
    children: PanelDefinition[];
};

/**
 * Definition for a tabs component
 */
export type PanelDefinition = ComponentDefinition & {
    /** List of definitions for individual tabs */
    children: TabDefinition[];
};

/**
 * Definition for a single tab in a tabs component
 */
export type TabDefinition = ParentComponentDefinition & {
    /** The label that appears at the top of the tabs object. */
    label: string;
};

/**
 * Definition for the map component
 */
export type MapDefinition = ComponentDefinition & {
    /**
     * Enable/disable the click listener on the map for settings a goal
     */
    selectGoal?: boolean;
};

/**
 * Definition for the run stop button
 */
export type RunStopDefinition = ComponentDefinition;
