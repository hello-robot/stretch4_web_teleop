import React, { useState } from "react";
import ModalMobile from "../basic_components/ModalMobile";
import MagneticWrapper from "../static_components/MagneticWrapper";
import "operator/css/ActionSpeed.css";
import { buttonFunctionProvider } from "..";
import speedSlowIcon from "operator/icons/Speed_Slow.svg";
import speedMediumIcon from "operator/icons/Speed_Medium.svg";
import speedFastIcon from "operator/icons/Speed_Fast.svg";

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

/**
 * The different velocity settings to display.
 * Scale: 0 -> 1.6
 */
export const VELOCITY_SCALE: ActionSpeedDetails[] = [
    { label: "slow", speed: 0.5 },
    { label: "medium", speed: 1.0 },
    { label: "fast", speed: 1.5 },
];

const getSpeedByLabel = (label: string): number | undefined => {
    return VELOCITY_SCALE.find((item) => item.label === label)?.speed;
};

const getLabelBySpeed = (speed: number): string | undefined => {
    return VELOCITY_SCALE.find((item) => item.speed === speed)?.label;
};

const SPEED_ICONS: Record<string, string> = {
    slow: speedSlowIcon,
    medium: speedMediumIcon,
    fast: speedFastIcon,
};

const getIconBySpeed = (speed: number): string => {
    const label = getLabelBySpeed(speed);
    return label ? SPEED_ICONS[label] : speedMediumIcon;
};

/**The speed the interface should initialize with */
export const DEFAULT_VELOCITY_SCALE: number = VELOCITY_SCALE[1].speed;

/**
 * Set of buttons so the user can control the scaling of the speed for all controls.
 * @param props see {@link SpeedControlProps}
 */
export const ActionSpeed = (props: ActionSpeedProps) => {
    const [isModalOpen, setIsModalOpen] = React.useState<boolean>(false);

    return (
        <div className="action-speed">
            <ModalActionSpeed
                isOpen={isModalOpen}
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
    handleClose,
}) => {
    const [selectedSpeed, setSelectedSpeed] = useState<string>(
        VELOCITY_SCALE[1].label
    );

    const options: OptionItem[] = VELOCITY_SCALE.map((item) => ({
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
                                src={SPEED_ICONS[opt.value]}
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
