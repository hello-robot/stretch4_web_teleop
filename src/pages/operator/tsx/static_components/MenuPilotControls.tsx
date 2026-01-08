import React, { useState } from "react";
import ModalMobile from "../basic_components/ModalMobile";
import MagneticWrapper from "../static_components/MagneticWrapper";
import "operator/css/MenuPilotControls.css";
import { buttonFunctionProvider } from "..";
import { PilotButtonPadType } from "../utils/component_definitions";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";

// Button icons (small, for main button)
import pilotIconDrive from "operator/icons/Pilot_Icon_Drive.svg";
import pilotIconArmGripper from "operator/icons/Pilot_Icon_ArmGripper.svg";
import pilotIconWrist from "operator/icons/Pilot_Icon_Wrist.svg";

// Option icons (for modal options)
import pilotOptionDrive from "operator/icons/Pilot_Option_Drive.svg";
import pilotOptionArmGripper from "operator/icons/Pilot_Option_ArmGripper.svg";
import pilotOptionWrist from "operator/icons/Pilot_Option_Wrist.svg";

// Grab Assist icon
import grabAssistIcon from "operator/icons/Grab_Assist.svg";

/**
 * The pilot button pad options available.
 */
export const PilotButtonPads: PilotButtonPadType[] = [
    PilotButtonPadType.BaseDrive,
    PilotButtonPadType.ArmGripper,
    PilotButtonPadType.Wrist,
] as const;

// Icon mappings for button icons (small)
const PILOT_BUTTON_ICONS: Record<string, string> = {
    [PilotButtonPadType.BaseDrive]: pilotIconDrive,
    [PilotButtonPadType.ArmGripper]: pilotIconArmGripper,
    [PilotButtonPadType.Wrist]: pilotIconWrist,
};

// Icon mappings for option icons (in modal)
const PILOT_OPTION_ICONS: Record<string, string> = {
    [PilotButtonPadType.BaseDrive]: pilotOptionDrive,
    [PilotButtonPadType.ArmGripper]: pilotOptionArmGripper,
    [PilotButtonPadType.Wrist]: pilotOptionWrist,
};

const getButtonIcon = (buttonPad: string): string => {
    return PILOT_BUTTON_ICONS[buttonPad] || pilotIconDrive;
};

const getOptionIcon = (buttonPad: string): string => {
    return PILOT_OPTION_ICONS[buttonPad] || pilotOptionDrive;
};

/**Props for {@link MenuPilotControls} */
type MenuPilotControlsProps = {
    /** Current button pad selected */
    buttonPad: string;

    /** Function to set the current button pad selected */
    onChange: (value: string) => void;

    /**
     * Whether or not the camera veil is currently displayed.
     */
    isCameraVeilVisible?: boolean;

    /**
     * Callback function to display the camera veil when the button pad modal is open.
     * @param enable whether or not to display the camera veil
     */
    setCameraVeilCallback: (enable: boolean) => void;

    /** The current button pad selected */
    pilotControlsCurrent: string;

    /** Function to set the current button pad selected */
    setPilotControlsCurrent: React.Dispatch<React.SetStateAction<string>>;
};

export const MenuPilotControls: React.FC<MenuPilotControlsProps> = ({
    pilotControlsCurrent,
    setPilotControlsCurrent,
    buttonPad,
    onChange,
    isCameraVeilVisible = false,
    setCameraVeilCallback,
}) => {
    const [isModalOpen, setIsModalOpen] = React.useState<boolean>(false);
    const getButtonPadByLabel = (label: string): string | undefined => {
        return PilotButtonPads.find((item) => item === label);
    };

    return (
        <div className="menu-pilot-controls">
            <ModalMenuPilotControls
                PilotButtonPads={PilotButtonPads}
                pilotControlsCurrent={pilotControlsCurrent}
                setPilotControlsCurrent={setPilotControlsCurrent}
                isOpen={isModalOpen}
                handleClose={(newButtonPadLabel: string) => {
                    setIsModalOpen(false);
                    setCameraVeilCallback(false);
                    onChange(getButtonPadByLabel(newButtonPadLabel));
                }}
            />
            <MagneticWrapper>
                <button
                    onPointerDown={() => {
                        setIsModalOpen(!isModalOpen);
                        setCameraVeilCallback(!isModalOpen);
                        buttonFunctionProvider.disableActiveButton();
                    }}
                    aria-label="Change button pad"
                    aria-hidden={isCameraVeilVisible}
                >
                    <img
                        src={getButtonIcon(buttonPad)}
                        alt={`Button pad: ${buttonPad}`}
                        className="icon"
                    />
                </button>
            </MagneticWrapper>
        </div>
    );
};

interface ModalMenuPilotControlsProps {
    PilotButtonPads: PilotButtonPadType[];
    isOpen: boolean;
    pilotControlsCurrent: string;
    setPilotControlsCurrent: React.Dispatch<React.SetStateAction<string>>;
    handleClose: (newButtonPadLabel: string) => void;
}

const ModalMenuPilotControls: React.FC<ModalMenuPilotControlsProps> = ({
    PilotButtonPads,
    pilotControlsCurrent,
    setPilotControlsCurrent,
    isOpen,
    handleClose,
}) => {
    const handleButtonPadSelection = (buttonPad: string) => {
        setPilotControlsCurrent(buttonPad);
        setTimeout(() => handleClose(buttonPad), 500);
    };

    const close = () => {
        // Close without selecting a new button pad
        handleClose(pilotControlsCurrent);
    };

    return (
        <ModalMobile
            isOpen={isOpen}
            title="Button Pad"
            subtitle="SELECT"
            modalClassName="menu-pilot-controls-modal"
            handleClose={close}
            hasCloseButton
            hasBgColor={false}
        >
            <div className="menu-pilot-controls-content">
                {/* Button Group */}
                <div className="menu-pilot-controls-options">
                    {PilotButtonPads.map((buttonPad) => {
                        const ariaLabel = `Select \"${buttonPad}\"`;
                        return (
                            <button
                                key={buttonPad}
                                className={`${buttonPad} ${pilotControlsCurrent === buttonPad ? "selected" : ""}`}
                                aria-label={ariaLabel}
                                aria-hidden={!isOpen}
                                onPointerDown={() =>
                                    handleButtonPadSelection(buttonPad)
                                }
                            >
                                <img
                                    src={getOptionIcon(buttonPad)}
                                    alt={buttonPad}
                                    className="option-icon"
                                />
                            </button>
                        );
                    })}
                </div>
                {/* Button Group Labels */}
                <div>
                    <div className="menu-pilot-controls-labels">
                        {PilotButtonPads.map((buttonPad) => (
                            <div
                                key={`label-${buttonPad}`}
                                className={`menu-pilot-controls-label ${pilotControlsCurrent === buttonPad ? "selected" : ""}`}
                                aria-hidden="true"
                            >
                                {buttonPad.charAt(0).toUpperCase() +
                                    buttonPad.slice(1)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="grab-assist">
                <button
                    className="grab-assist-button"
                    onPointerDown={() => {
                        // TODO: Add grab assist functionality
                        console.log("Grab Assist");
                    }}
                >
                    <div>
                        <img
                            src={grabAssistIcon}
                            alt="Grab Assist"
                            className="icon"
                        />
                        <div className="copy">
                            <div className="heading">Use Grab Assist</div>
                            <div className="subheading">
                                Stretch will align its gripper with the object
                                you want to grab.
                            </div>
                        </div>
                    </div>
                    <ArrowForwardIcon className="arrow-forward" />
                </button>
            </div>
        </ModalMobile>
    );
};
