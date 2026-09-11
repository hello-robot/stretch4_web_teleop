import React, { useState } from "react";
import ModalMobile from "../basic_components/ModalMobile";
import MagneticWrapper from "../static_components/MagneticWrapper";
import "operator/css/ActionSpeed.css";
import { buttonFunctionProvider } from "..";
import speedSlowIcon from "operator/icons/Speed_Slow.svg";
import speedMediumIcon from "operator/icons/Speed_Medium.svg";
import speedFastIcon from "operator/icons/Speed_Fast.svg";
import speedSlowIconWithoutText from "operator/icons/Speed_Slow_Without_Text.svg";
import speedMediumIconWithoutText from "operator/icons/Speed_Medium_Without_Text.svg";
import speedFastIconWithoutText from "operator/icons/Speed_Fast_Without_Text.svg";

import {
    getLabelBySpeed,
    getSpeedByLabel,
    VELOCITY_SCALE,
} from "../utils/action-speed-scale";

/**Details of a velocity setting */
type ActionSpeedDetails = {
    /**Name of the setting to display on the button */
    label: string;
    /**The speed of this setting */
    speed: number;
};

/**Props for {@link ActionSpeed} */
type ActionSpeedProps = {
    /** Initial speed when interface first loaded. */
    speed: number;

    /**
     * Callback function when a new speed is selected.
     * @param newSpeed the new selected speed
     */
    onChange: (newScale: number) => void;

    /**
     * Whether or not the camera veil is currently displayed.
     */
    isCameraVeilVisible?: boolean;

    /**
     * Callback function to display the camera veil when the action speed modal is open.
     * @param enable whether or not to display the camera veil
     */
    setCameraVeilCallback: (enable: boolean) => void;
};

const VELOCITY_SCALE_UI: ActionSpeedDetails[] = VELOCITY_SCALE;

const SPEED_ICONS: Record<string, string> = {
    slow: speedSlowIcon,
    medium: speedMediumIcon,
    fast: speedFastIcon,
};

const SPEED_ICONS_WITHOUT_TEXT: Record<string, string> = {
    slow: speedSlowIconWithoutText,
    medium: speedMediumIconWithoutText,
    fast: speedFastIconWithoutText,
};

const getIconBySpeed = (speed: number): string => {
    const label = getLabelBySpeed(speed);
    return label ? SPEED_ICONS[label] : speedMediumIcon;
};

/**
 * Set of buttons so the user can control the scaling of the speed for all controls.
 * @param props see {@link SpeedControlProps}
 */
export const ActionSpeed = (props: ActionSpeedProps) => {
    const [isModalOpen, setIsModalOpen] = React.useState<boolean>(false);
    const speedLabel =
        getLabelBySpeed(props.speed) ?? VELOCITY_SCALE_UI[1].label;

    return (
        <div className="action-speed">
            <ModalActionSpeed
                isOpen={isModalOpen}
                speedLabel={speedLabel}
                handleClose={(newSpeedLabel: string) => {
                    setIsModalOpen(false);
                    props.setCameraVeilCallback(false);
                    props.onChange(getSpeedByLabel(newSpeedLabel));
                }}
            />
            <MagneticWrapper>
                <button
                    className="button-action-speed"
                    onPointerDown={() => {
                        setIsModalOpen(!isModalOpen);
                        props.setCameraVeilCallback(!isModalOpen);
                        buttonFunctionProvider.disableActiveButton();
                    }}
                    aria-label="Change action speed"
                    aria-hidden={props.isCameraVeilVisible}
                >
                    <img
                        src={getIconBySpeed(props.speed)}
                        alt={`Speed: ${getLabelBySpeed(props.speed)}`}
                        className="action-speed-icon"
                    />
                </button>
            </MagneticWrapper>
        </div>
    );
};

interface ModalActionSpeedProps {
    isOpen: boolean;
    speedLabel: string;
    /**
     * Function handles behavior modal close
     * @param newSpeedLabel the label for the newly selected speed
     */
    handleClose: (newSpeedLabel: string) => void;
}

interface OptionItem {
    value: string;
}

const ModalActionSpeed: React.FC<ModalActionSpeedProps> = ({
    isOpen,
    speedLabel,
    handleClose,
}) => {
    const [selectedSpeed, setSelectedSpeed] = useState<string>(speedLabel);

    React.useEffect(() => {
        setSelectedSpeed(speedLabel);
    }, [speedLabel, isOpen]);

    const options: OptionItem[] = VELOCITY_SCALE_UI.map((item) => ({
        value: item.label,
    }));

    const handleSpeedSelection = (speed: string) => {
        setSelectedSpeed(speed);
        setTimeout(() => handleClose(speed), 500);
    };

    const close = () => {
        // Close without selecting a new button pad
        setTimeout(() => handleClose(selectedSpeed), 500);
    };

    return (
        <ModalMobile
            isOpen={isOpen}
            title="Action Speed"
            subtitle="NAVIGATE"
            handleClose={close}
            hasCloseButton
            modalClassName="action-speed-modal"
        >
            <div className="action-speed-options">
                {options.map((opt) => {
                    const ariaLabel = `Select \"${opt.value}\" speed`;

                    return (
                        <button
                            key={opt.value}
                            className={`${opt.value} ${selectedSpeed === opt.value ? "selected" : ""}`}
                            aria-label={ariaLabel}
                            aria-hidden={!isOpen}
                            onPointerDown={() =>
                                handleSpeedSelection(opt.value)
                            }
                        >
                            <img
                                src={SPEED_ICONS_WITHOUT_TEXT[opt.value]}
                                alt=""
                                className="speed-option-icon"
                                aria-hidden="true"
                            />
                            {/* Adding arbitrary text inside <span/> changes the position of iOS voice control labels */}
                            <span className="aria-inviz" aria-hidden="true"></span>
                        </button>
                    );
                })}
            </div>
            <div>
                <div className="action-speed-labels">
                    {options.map((opt) => (
                        <div
                            key={`label-${opt.value}`}
                            className={`speed-label ${selectedSpeed === opt.value ? "selected" : ""}`}
                            aria-hidden="true"
                        >
                            {opt.value.charAt(0).toUpperCase() +
                                opt.value.slice(1)}
                        </div>
                    ))}
                </div>
            </div>
        </ModalMobile>
    );
};
