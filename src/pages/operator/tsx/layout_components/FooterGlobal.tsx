import React, { useEffect, useMemo, useRef, useState } from "react";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";

import "operator/css/FooterGlobal.css";
import batteryIcon from "operator/icons/Battery_Footer.svg";
import runStopRunIcon from "operator/icons/RunStop_Run.svg";
import runStopStopIcon from "operator/icons/RunStop_Stop.svg";
import { ActionState } from "shared/util";
import { mapFunctionProvider, runStopFunctionProvider } from "..";
import MainMenu from "../basic_components/MainMenu";
import SceneCarousel, {
    SceneItem,
    SceneItemStatus,
} from "../basic_components/SceneCarousel";
import { RunStopFunctions } from "../function_providers/RunStopFunctionProvider";
import MagneticWrapper from "../static_components/MagneticWrapper";
import VoicePilotSceneChrome from "../static_components/VoicePilotSceneChrome";
import { bumpVoiceCommandActivity } from "../voice/voiceCommandActivity";
import {
    getVoiceStatusSnapshot,
    setVoiceStatus,
    useVoiceStatus,
} from "../voice/voiceStatusStore";
import { MapFunction } from "./AutoNav";

const LOCALIZE_SUCCESS_HOLD_MS = 1500;

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
    const [localizeStatus, localizeStatusSet] =
        useState<SceneItemStatus>("idle");
    const localizeStatusRef = useRef<SceneItemStatus>(localizeStatus);
    const localizeSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

    localizeStatusRef.current = localizeStatus;

    runStopFunctionProvider.setRunStopStateChangeCallback(isRunStoppedSet);
    const functs: RunStopFunctions = runStopFunctionProvider.provideFunctions();

    // Re-register each render (provider may be created after first mount).
    mapFunctionProvider?.setOperatorCallback((state: ActionState) => {
        if (state.alert_type === "success") {
            localizeStatusSet("success");
            if (localizeSuccessTimeoutRef.current) {
                clearTimeout(localizeSuccessTimeoutRef.current);
            }
            localizeSuccessTimeoutRef.current = setTimeout(() => {
                onSceneSelectedChange("autonav");
                swipeableViewsIdxSet(1);
                isMainMenuOpenSet(false);
                localizeStatusSet("idle");
            }, LOCALIZE_SUCCESS_HOLD_MS);
            return;
        }
        if (state.alert_type === "error") {
            localizeStatusSet("error");
        }
    });

    useEffect(() => {
        return () => {
            if (localizeSuccessTimeoutRef.current) {
                clearTimeout(localizeSuccessTimeoutRef.current);
            }
        };
    }, []);

    const startLocalizeAruco = () => {
        if (localizeStatusRef.current === "loading") {
            return;
        }
        if (localizeSuccessTimeoutRef.current) {
            clearTimeout(localizeSuccessTimeoutRef.current);
        }
        localizeStatusSet("loading");
        const seedLocalization = mapFunctionProvider?.provideFunctions(
            MapFunction.SeedLocalization
        ) as (() => void) | undefined;
        seedLocalization?.();
    };

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
                enabled: true,
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
                enabled: true,
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
                id: "localize-aruco",
                name: "Localize (ArUco)",
                description: "TextDescription",
                onClick: startLocalizeAruco,
                icon: <CheckCircleIcon />,
                enabled: localizeStatus !== "loading",
                status: localizeStatus,
            },
            {
                id: "finedex-gripper",
                name: "FineDex Gripper",
                description: "TextDescription",
                onClick: () => console.log("You selected 'finedex-gripper'"),
                icon: <CheckCircleIcon />,
                enabled: false,
            },
            {
                id: "autodock",
                name: "AutoDock",
                description: "TextDescription",
                onClick: () => console.log("You selected 'autodock'"),
                icon: <CheckCircleIcon />,
                enabled: false,
            },
            {
                id: "feeding",
                name: "Feeding",
                description: "TextDescription",
                onClick: () => console.log("You selected 'feeding'"),
                icon: <CheckCircleIcon />,
                enabled: false,
            },
            {
                id: "settings",
                name: "Settings",
                description: "TextDescription",
                onClick: () => console.log("You selected 'settings'"),
                icon: <CheckCircleIcon />,
                enabled: false,
            },
        ],
        [
            micMuted,
            voiceConnected,
            localizeStatus,
            onSceneSelectedChange,
            swipeableViewsIdxSet,
        ]
    );

    const handleSceneSelect = (scene: SceneItem) => {
        // Action-only items run their handler without switching the active scene.
        if (scene.id === "mic-mute" || scene.id === "localize-aruco") {
            if (localizeStatus === "loading") {
                return;
            }
            scene.onClick?.();
            return;
        }
        if (scene.id === "localize-aruco") {
            if (localizeStatus === "loading") {
                return;
            }
            scene.onClick?.();
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
