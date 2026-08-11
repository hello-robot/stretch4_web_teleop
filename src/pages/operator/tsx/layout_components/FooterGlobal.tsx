import React, { useMemo, useState } from "react";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";

import MainMenu from "../basic_components/MainMenu";
import SceneCarousel, {
    SceneItem,
} from "../basic_components/SceneCarousel";
import MagneticWrapper from "../static_components/MagneticWrapper";
import VoicePilotSceneChrome from "../static_components/VoicePilotSceneChrome";
import batteryIcon from "operator/icons/Battery_Footer.svg";
import runStopRunIcon from "operator/icons/RunStop_Run.svg";
import runStopStopIcon from "operator/icons/RunStop_Stop.svg";
import "operator/css/FooterGlobal.css";
import { runStopFunctionProvider } from "..";
import { RunStopFunctions } from "../function_providers/RunStopFunctionProvider";
import {
    getVoiceStatusSnapshot,
    setVoiceStatus,
    useVoiceStatus,
} from "../voice/voiceStatusStore";
import { bumpVoiceCommandActivity } from "../voice/voiceCommandActivity";

/** Menu tiles that run an action without changing the selected scene/footer label. */
const ACTION_TILE_IDS = new Set(["mic-mute", "reload-app"]);

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
    const [isRunStopped, isRunStoppedSet] = useState<boolean>(false);
    const [isMainMenuOpen, isMainMenuOpenSet] = useState<boolean>(false);
    const { connected: voiceConnected, micMuted } = useVoiceStatus();

    runStopFunctionProvider.setRunStopStateChangeCallback(isRunStoppedSet);
    const functs: RunStopFunctions = runStopFunctionProvider.provideFunctions();

    const scenes: SceneItem[] = useMemo(
        () => [
            {
                id: "pilot-mode",
                name: "Pilot",
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
                id: "mic-mute",
                name: micMuted ? "Unmute" : "Mute",
                description: "Toggle microphone uplink to OpenAI",
                onClick: () => {
                    const nextMuted = !getVoiceStatusSnapshot().micMuted;
                    if (!nextMuted) {
                        bumpVoiceCommandActivity();
                    }
                    setVoiceStatus({ micMuted: nextMuted });
                },
                icon: micMuted ? <MicOffIcon /> : <MicIcon />,
                enabled: voiceConnected,
            },
            {
                id: "reload-app",
                name: "Reload App",
                description: "Reload the operator page",
                onClick: () => {
                    window.location.reload();
                },
                enabled: true,
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
        [
            onSceneSelectedChange,
            swipeableViewsIdxSet,
            micMuted,
            voiceConnected,
        ]
    );

    const handleSceneSelect = (scene: SceneItem) => {
        if (ACTION_TILE_IDS.has(scene.id)) {
            scene.onClick?.();
            isMainMenuOpenSet(false);
            return;
        }
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
                <img src={batteryIcon} alt="Battery" className="battery" />
            </div>
            <div className="scene-menu-button-container">
                <button
                    className="scene-menu-button"
                    onPointerUp={() => isMainMenuOpenSet(true)}
                >
                    <VoicePilotSceneChrome
                        sceneSelected={sceneSelected}
                        fallbackName={sceneNameCurrent}
                    />
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
                    onClick={() => functs.onClick()}
                    type="button"
                    className={`run-stop-button ${isRunStopped ? "stopped" : "running"}`}
                    aria-label={isRunStopped ? "Run" : "Stop"}
                >
                    <img
                        src={!isRunStopped ? runStopStopIcon : runStopRunIcon}
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
