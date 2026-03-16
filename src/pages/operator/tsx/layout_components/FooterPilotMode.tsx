import React, { useState } from "react";
import { ActionSpeed } from "../static_components/ActionSpeed";
import { MenuPilotControls } from "../static_components/MenuPilotControls";
import {
    ActionModeType,
    PilotButtonPadType,
} from "../utils/component_definitions";
import { ActionMode } from "../static_components/ActionMode";
import "operator/css/FooterPilotMode.css";

interface FooterControlsProps {
    pilotControlsCurrent: PilotButtonPadType;
    setPilotControlsCurrent: (value: string) => void;
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
    pilotControlsCurrent,
    setPilotControlsCurrent,
    actionSpeedCurrent,
    onActionSpeedChange,
    actionModeCurrent,
    onActionModeChange,
    isCameraVeilVisibleSet,
    isCameraVeilVisible,
    swipeableViewsIdxSet,
    sceneSelected,
    onSceneSelectedChange,
}) => {
    const [isStopped, isStoppedSet] = useState<boolean>(false);

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
                <MenuPilotControls
                    buttonPad={pilotControlsCurrent}
                    onChange={setPilotControlsCurrent}
                    isCameraVeilVisible={isCameraVeilVisible}
                    setCameraVeilCallback={isCameraVeilVisibleSet}
                    pilotControlsCurrent={pilotControlsCurrent}
                    setPilotControlsCurrent={setPilotControlsCurrent}
                />
            </div>
        </div>
    );
};

export default FooterHeadCam;
