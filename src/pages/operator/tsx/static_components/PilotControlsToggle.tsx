import React, { useEffect, useRef } from "react";
import "operator/css/PilotControlsToggle.css";
import { buttonFunctionProvider } from "..";
import { PilotButtonPadType } from "../utils/component_definitions";

// Button icons (small, for main button)
import pilotIconDrive from "operator/icons/Pilot_Icon_Drive.svg";
import pilotIconArmGripper from "operator/icons/Pilot_Icon_ArmGripper.svg";

// ButtonPad options
export const PilotButtonPads: PilotButtonPadType[] = [
    PilotButtonPadType.BaseDrive,
    PilotButtonPadType.ArmGripper,
    PilotButtonPadType.Wrist,
] as const;

// Icons!
const PILOT_BUTTON_ICONS: Record<string, string> = {
    [PilotButtonPadType.BaseDrive]: pilotIconDrive,
    [PilotButtonPadType.ArmGripper]: pilotIconArmGripper,
    // For now, Wrist uses identical icon as ArmGripper
    [PilotButtonPadType.Wrist]: pilotIconArmGripper,
};

const getButtonIcon = (buttonPad: string): string => {
    return PILOT_BUTTON_ICONS[buttonPad] || pilotIconDrive;
};

/**Props for {@link PilotControlsToggle} */
type PilotControlsToggleProps = {

    // Function to set the current ButtonPad selected
    onChange: (value: string) => void;

    // Whether or not the camera veil is currently displayed.
    isCameraVeilVisible?: boolean;

    // The current ButtonPad selected
    pilotControlsCurrent: string;
};

export const PilotControlsToggle: React.FC<PilotControlsToggleProps> = ({
    pilotControlsCurrent,
    onChange,
    isCameraVeilVisible = false,
}) => {
    const lastArmPadRef = useRef<PilotButtonPadType>(
        pilotControlsCurrent === PilotButtonPadType.Wrist
            ? PilotButtonPadType.Wrist
            : PilotButtonPadType.ArmGripper
    );

    useEffect(() => {
        if (
            pilotControlsCurrent === PilotButtonPadType.ArmGripper ||
            pilotControlsCurrent === PilotButtonPadType.Wrist
        ) {
            lastArmPadRef.current = pilotControlsCurrent;
        }
    }, [pilotControlsCurrent]);

    const isDrive = pilotControlsCurrent === PilotButtonPadType.BaseDrive;

    const handleToggle = () => {
        buttonFunctionProvider.disableActiveButton();
        if (isDrive) {
            onChange(lastArmPadRef.current);
        } else {
            onChange(PilotButtonPadType.BaseDrive);
        }
    };

    const handleArmTab = (pad: PilotButtonPadType.ArmGripper | PilotButtonPadType.Wrist) => {
        buttonFunctionProvider.disableActiveButton();
        lastArmPadRef.current = pad;
        onChange(pad);
    };

    const toggleAriaLabel = isDrive
        ? "Switch to arm controls"
        : "Switch to drive controls";

    return (
        <div
            className={`pilot-controls-toggle ${isCameraVeilVisible ? 'hidden' : ''}`}
        >
            <div
                className="pilot-controls-toggle-slot"
                aria-hidden={isCameraVeilVisible}
            >
                <div className="pilot-controls-toggle">
                    <div className="pilot-controls-toggle-toggle-wrap">
                        {/* Toggle button! */}
                        <button
                            onPointerDown={handleToggle}
                            aria-label={toggleAriaLabel}
                            aria-hidden={isCameraVeilVisible}
                            className="pilot-controls-toggle-btn"
                            type="button"
                        >
                            <img
                                src={getButtonIcon(pilotControlsCurrent)}
                                alt={`Button pad: ${pilotControlsCurrent}`}
                                className="icon"
                            />
                        </button>
                    </div>

                    {/*
                        Tab Control UI
                     */}
                    <div
                        className={`pilot-controls-toggle-tab-control ${isDrive ? "pilot-controls-toggle-tab-control--drive" : "pilot-controls-toggle-tab-control--arm-gripper-wrist"}`}
                        role="tablist"
                        aria-label="Button pad mode"
                        aria-hidden={isCameraVeilVisible}
                    >
                        {isDrive ? (
                            <div
                                className="pilot-controls-toggle-tab pilot-controls-toggle-tab--active pilot-controls-toggle-tab--static"
                                role="tab"
                                aria-selected={true}
                            >
                                {PilotButtonPadType.BaseDrive}
                            </div>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={
                                        pilotControlsCurrent === PilotButtonPadType.ArmGripper
                                    }
                                    className={`pilot-controls-toggle-tab ${pilotControlsCurrent === PilotButtonPadType.ArmGripper ? "pilot-controls-toggle-tab--active" : ""}`}
                                    onPointerDown={() =>
                                        handleArmTab(PilotButtonPadType.ArmGripper)
                                    }
                                >
                                    {PilotButtonPadType.ArmGripper}
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={
                                        pilotControlsCurrent === PilotButtonPadType.Wrist
                                    }
                                    className={`pilot-controls-toggle-tab ${pilotControlsCurrent === PilotButtonPadType.Wrist ? "pilot-controls-toggle-tab--active" : ""}`}
                                    onPointerDown={() =>
                                        handleArmTab(PilotButtonPadType.Wrist)
                                    }
                                >
                                    {PilotButtonPadType.Wrist}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>

    );
};
