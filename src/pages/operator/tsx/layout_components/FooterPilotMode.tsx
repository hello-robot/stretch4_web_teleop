import React from "react";
import { ActionSpeed } from "../static_components/ActionSpeed";
import {
    ActionModeType,
    CameraViewId,
} from "../utils/component_definitions";
import { ActionMode } from "../static_components/ActionMode";
import { CameraSwitcher } from "../static_components/CameraSwitcher";
import "operator/css/FooterPilotMode.css";

interface FooterControlsProps {
    cameraID: CameraViewId;
    setCameraID: (id: CameraViewId) => void;
    actionSpeedCurrent?: number;
    onActionSpeedChange: (newSpeed: number) => void;
    actionModeCurrent?: ActionModeType;
    onActionModeChange?: (newMode: ActionModeType) => void;
    isCameraVeilVisible: boolean;
    isCameraVeilVisibleSet: React.Dispatch<React.SetStateAction<boolean>>;
    swipeableViewsIdxSet: React.Dispatch<React.SetStateAction<number>>;
    sceneSelected: string;
    onSceneSelectedChange: React.Dispatch<React.SetStateAction<string>>;
}

const FooterHeadCam: React.FC<FooterControlsProps> = ({
    cameraID,
    setCameraID,
    actionSpeedCurrent,
    onActionSpeedChange,
    actionModeCurrent,
    onActionModeChange,
    isCameraVeilVisibleSet,
    isCameraVeilVisible,
}) => {
    return (
        <div className="footer-pilot-mode">
            <div className="footer-row">
                <ActionSpeed
                    speed={actionSpeedCurrent}
                    onChange={onActionSpeedChange}
                    isCameraVeilVisible={isCameraVeilVisible}
                    setCameraVeilCallback={isCameraVeilVisibleSet}
                />
                <ActionMode
                    mode={actionModeCurrent}
                    onChange={onActionModeChange}
                    isCameraVeilVisible={isCameraVeilVisible}
                    setCameraVeilCallback={isCameraVeilVisibleSet}
                />

                <CameraSwitcher
                    isCameraVeilVisible={isCameraVeilVisible}
                    setCameraVeilCallback={isCameraVeilVisibleSet}
                />
            </div>
        </div>
    );
};

export default FooterHeadCam;
