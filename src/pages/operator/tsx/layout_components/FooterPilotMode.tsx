import React, { useState } from "react";
import { BatteryGauge } from "../static_components/BatteryGauge";
import { ActionSpeed } from "../static_components/ActionSpeed";
import { ActionModeType } from "../utils/component_definitions";
import { ActionMode } from "../static_components/ActionMode";
import "operator/css/FooterPilotMode.css";
import FooterGlobal from "./FooterGlobal";
import pilotSelectorIcon from "operator/icons/Pilot_Selector.svg";

interface FooterControlsProps {
    actionSpeedCurrent?: number;
    onActionSpeedChange: (newSpeed: number) => void;
    actionModeCurrent?: ActionModeType;
    onActionModeChange?: (newMode: ActionModeType) => void;
    isCameraVeilVisible: boolean;
    isCameraVeilVisibleSet: React.Dispatch<React.SetStateAction<boolean>>;
    swipeableViewsIdxSet: React.Dispatch<React.SetStateAction<number>>;
}

const FooterPilotMode: React.FC<FooterControlsProps> = ({
    actionSpeedCurrent,
    onActionSpeedChange,
    actionModeCurrent,
    onActionModeChange,
    isCameraVeilVisibleSet,
    isCameraVeilVisible,
    swipeableViewsIdxSet,
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
                <div className="pilot-selection-dropdown">
                    <button
                        onClick={() =>
                            console.log("Tapped on ButtonPad switcher")
                        }
                    >
                        <img
                            src={pilotSelectorIcon}
                            alt="Pilot selector"
                            className="icon"
                        />
                    </button>
                </div>
            </div>
            <div className="footer-row">
                <FooterGlobal />
            </div>
        </div>
    );
};

export default FooterPilotMode;
