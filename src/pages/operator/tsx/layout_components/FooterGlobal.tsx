import React, { useMemo, useState } from "react";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";

import MainMenu from "../basic_components/MainMenu";
import SceneCarousel, {
    SceneItem,
} from "../basic_components/SceneCarousel";
import MagneticWrapper from "../static_components/MagneticWrapper";
import batteryIcon from "operator/icons/Battery_Footer.svg";
import runStopRunIcon from "operator/icons/RunStop_Run.svg";
import runStopStopIcon from "operator/icons/RunStop_Stop.svg";
import "operator/css/FooterGlobal.css";
import { batteryStateFunctionProvider } from "..";
import { BatteryStateFunctions } from "../function_providers/BatteryStateFunctionProvider";

interface FooterGlobalProps {
    swipeableViewsIdxSet: React.Dispatch<React.SetStateAction<number>>;
    sceneSelected: string;
    onSceneSelectedChange: React.Dispatch<React.SetStateAction<string>>;
}

const FooterGlobal: React.FC<FooterGlobalProps> = ({
    swipeableViewsIdxSet,
    sceneSelected,
    onSceneSelectedChange,
}) => {
    const [isStopped, isStoppedSet] = useState<boolean>(false);
    const [isMainMenuOpen, isMainMenuOpenSet] = useState<boolean>(false);
    const [batteryPercentage, batteryPercentageSet] = useState<number>(0);
    const [isCharging, isChargingSet] = useState<boolean>(false);

    const batteryFuncts: BatteryStateFunctions = batteryStateFunctionProvider.provideFunctions();
    batteryStateFunctionProvider.setPercentageChangeCallback(batteryPercentageSet);
    batteryStateFunctionProvider.setChargeStateChangeCallback(isChargingSet);
    
    const scenes: SceneItem[] = useMemo(
        () => [
            {
                id: "pilot-mode",
                name: "Pilot Mode",
                description: "TextDescription",
                onClick: () => {
                    swipeableViewsIdxSet(0);
                    onSceneSelectedChange("pilot-mode");
                },
                icon: <CheckCircleIcon />,
                enabled: true
            },
            {
                id: "autonav",
                name: "AutoNav",
                description: "TextDescription",
                onClick: () => {
                    onSceneSelectedChange("autonav");
                    swipeableViewsIdxSet(1);
                },
                icon: <CheckCircleIcon />,
                enabled: true
            },
            {
                id: "finedex-gripper",
                name: "FineDex Gripper",
                description: "TextDescription",
                onClick: () => console.log("You selected 'finedex-gripper'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "autodock",
                name: "AutoDock",
                description: "TextDescription",
                onClick: () => console.log("You selected 'autodock'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "feeding",
                name: "Feeding",
                description: "TextDescription",
                onClick: () => console.log("You selected 'feeding'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "settings",
                name: "Settings",
                description: "TextDescription",
                onClick: () => console.log("You selected 'settings'"),
                icon: <CheckCircleIcon />,
                enabled: false
            }
        ],
        [onSceneSelectedChange, swipeableViewsIdxSet]
    );

    const handleSceneSelect = (scene: SceneItem) => {
        onSceneSelectedChange(scene.id);
        scene.onClick?.();
        isMainMenuOpenSet(false);
    };

    const sceneNameCurrent = scenes.find(
        (scene) => scene.id === sceneSelected
    )?.name;

    return (
        <div className="footer-global">
            <div className="battery-container">
                <img src={batteryFuncts.getBatteryIcon()} alt="Battery" className="battery" />
            </div>
            <div className="scene-menu-button-container">
                <button
                    className="scene-menu-button"
                    onPointerUp={() => isMainMenuOpenSet(true)}
                >
                    {sceneNameCurrent}
                    <div className="fancy-border" />
                </button>
                <MainMenu
                    isOpen={isMainMenuOpen}
                    title="Main Menu"
                    children={
                        <SceneCarousel
                            scenes={scenes}
                            onSceneSelect={handleSceneSelect}
                            selectedSceneId={sceneSelected}
                            NavButtonWrapper={MagneticWrapper}
                        />
                    }
                />
            </div>
            <div className="run-stop-container">
                <button
                    onClick={() => isStoppedSet(!isStopped)}
                    type="button"
                    className={`run-stop-button ${isStopped ? "stopped" : "running"}`}
                    aria-label={isStopped ? "Run" : "Stop"}
                >
                    <img
                        src={!isStopped ? runStopStopIcon : runStopRunIcon}
                        alt=""
                        aria-hidden="true"
                        className="icon"
                    />
                </button>
            </div>
        </div>
    );
};

export default FooterGlobal;
