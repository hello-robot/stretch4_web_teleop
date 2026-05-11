import React, { useState } from "react";
import ModalMobile from "../basic_components/ModalMobile";
import MagneticWrapper from "./MagneticWrapper";
import "operator/css/CameraSwitcher.css";
import { CameraViewId, OverheadCameraID } from "../utils/component_definitions";

import cameraLeft from "operator/icons/Camera_Left.svg";
import cameraCenter from "operator/icons/Camera_Center.svg";
import cameraRight from "operator/icons/Camera_Right.svg";
import cameraLeftWithoutText from "operator/icons/Camera_Left_Without_Text.svg";
import cameraCenterWithoutText from "operator/icons/Camera_Center_Without_Text.svg";
import cameraRightWithoutText from "operator/icons/Camera_Right_Without_Text.svg";

import { CameraSwitcherFunctions } from "../function_providers/CameraSwitcherFunctionProvider";
import { cameraSwitcherFunctionProvider } from "..";

const CAMERA_OPTIONS: CameraViewId[] = [
    CameraViewId.gripper,
    CameraViewId.overhead,
];

const OVERHEAD_CAMERA_OPTIONS: OverheadCameraID[] = [
    OverheadCameraID.left,
    OverheadCameraID.center,
    OverheadCameraID.right,
];

const CAMERA_ICONS: Record<OverheadCameraID, string> = {
    [OverheadCameraID.left]: cameraLeft,
    [OverheadCameraID.center]: cameraCenter,
    [OverheadCameraID.right]: cameraRight,
};

const CAMERA_ICONS_WITHOUT_TEXT: Record<OverheadCameraID, string> = {
    [OverheadCameraID.left]: cameraLeftWithoutText,
    [OverheadCameraID.center]: cameraCenterWithoutText,
    [OverheadCameraID.right]: cameraRightWithoutText,
};

const CAMERA_LABELS: Record<OverheadCameraID, string> = {
    [OverheadCameraID.left]: "Left",
    [OverheadCameraID.center]: "Center",
    [OverheadCameraID.right]: "Right",
};

type MenuCameraSelectProps = {
    /** Current camera selected */
    cameraID: OverheadCameraID;

    /** Function to set the current camera selected */
    setCameraID: (id: OverheadCameraID) => void;

    /** Whether or not the camera veil is currently displayed. */
    isCameraVeilVisible?: boolean;

    /** Callback to toggle the camera veil when the modal is open. */
    setCameraVeilCallback: (enable: boolean) => void;
};

export const CameraSwitcher: React.FC<MenuCameraSelectProps> = ({
    isCameraVeilVisible = false,
    setCameraVeilCallback,
}) => {
    const [isModalOpen, isModalOpenSet] = useState<boolean>(false);
    const [cameraID, setCameraID] = useState<OverheadCameraID>(OverheadCameraID.right);

    return (
        <div className="footer-camera-switch-slot">
            <div className="menu-camera-select">
                <ModalMenuCameraSelect
                    cameraID={cameraID}
                    setCameraID={setCameraID}
                    isOpen={isModalOpen}
                    handleClose={() => {
                        isModalOpenSet(false);
                        setCameraVeilCallback(false);
                    }}
                />
                <MagneticWrapper>
                    <button
                        onPointerDown={() => {
                            isModalOpenSet(!isModalOpen);
                            setCameraVeilCallback(!isModalOpen);
                        }}
                        aria-label="Change camera"
                        aria-hidden={isCameraVeilVisible}
                        className="switch-camera-btn"
                        type="button"
                    >
                        <img
                            src={CAMERA_ICONS[cameraID]}
                            alt={`Camera: ${CAMERA_LABELS[cameraID] ?? ""}`}
                        />
                    </button>
                </MagneticWrapper>
            </div>
        </div>
    );
};

interface ModalMenuCameraSelectProps {
    cameraID: OverheadCameraID;
    setCameraID: (id: OverheadCameraID) => void;
    isOpen: boolean;
    handleClose: () => void;
}

const ModalMenuCameraSelect: React.FC<ModalMenuCameraSelectProps> = ({
    cameraID,
    setCameraID,
    isOpen,
    handleClose,
}) => {
    const handleCameraSelection = (id: OverheadCameraID) => {
        setCameraID(id);
        if (id === OverheadCameraID.left) {
            cameraSwitcherFunctionProvider.provideFunctions(
                CameraSwitcherFunctions.SetCameraLeft
            )();
        } else if (id === OverheadCameraID.center) {
            cameraSwitcherFunctionProvider.provideFunctions(
                CameraSwitcherFunctions.SetCameraCenter
            )();
        } else if (id === OverheadCameraID.right) {
            cameraSwitcherFunctionProvider.provideFunctions(
                CameraSwitcherFunctions.SetCameraRight
            )();
        }
        setTimeout(() => handleClose(), 500);
    };

    return (
        <ModalMobile
            isOpen={isOpen}
            title="Camera"
            subtitle="SELECT"
            modalClassName="menu-camera-select-modal"
            handleClose={handleClose}
            hasCloseButton
        >
            <div className="menu-camera-select-content">
                <div className="menu-camera-select-options">
                    {OVERHEAD_CAMERA_OPTIONS.map((id) => {
                        const label = CAMERA_LABELS[id];
                        const ariaLabel = `Select "${label}"`;
                        return (
                            <button
                                key={id}
                                className={`${id} ${cameraID === id ? "selected" : ""}`}
                                aria-label={ariaLabel}
                                aria-hidden={!isOpen}
                                onPointerDown={() => handleCameraSelection(id)}
                            >
                                <img
                                    src={CAMERA_ICONS_WITHOUT_TEXT[id]}
                                    alt={label}
                                    className="option-icon"
                                />
                            </button>
                        );
                    })}
                </div>
                <div>
                    <div className="menu-camera-select-labels">
                        {OVERHEAD_CAMERA_OPTIONS.map((id) => (
                            <div
                                key={`label-${id}`}
                                className={`menu-camera-select-label ${cameraID === id ? "selected" : ""}`}
                                aria-hidden="true"
                            >
                                {CAMERA_LABELS[id]}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </ModalMobile>
    );
};
