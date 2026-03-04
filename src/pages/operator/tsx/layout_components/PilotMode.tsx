import React, { Dispatch, useCallback, SetStateAction, useState } from "react";
import { SimpleCameraView } from "./SimpleCameraView";
import { TabGroup } from "../basic_components/TabGroup";
import FooterPilotMode from "./FooterPilotMode";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import { CameraViewId } from "../utils/component_definitions";
import cameraIcon from "operator/icons/Camera_Icon.svg";
import cameraLeft from "operator/icons/Camera_Left.svg";
import cameraCenter from "operator/icons/Camera_Center.svg";
import cameraRight from "operator/icons/Camera_Right.svg";
import {
    RadialCornerMenu,
    RadialCornerMenuOption,
} from "../basic_components/RadialCornerMenu";
import { pilotModeFunctionProvider } from "..";
import { AnimatePresence, motion } from "framer-motion";
import "../../css/PilotMode.css";
import { PilotModeFunctions } from "../function_providers/PilotModeFunctionProvider";

interface PilotModeProps {
    cameraID: CameraViewId;
    remoteStreams: any; // Replace 'any' with the actual type if known
    isCameraVeilVisible: boolean;
    isCameraVeilVisibleSet: (visible: boolean) => void;
    tabContent: ((active: boolean) => React.JSX.Element)[];
    activeMainGroupTab: number;
    setActiveMainGroupTab: (index: number) => void;
    setVelocityScale: (speed: number) => void;
    setActionMode: (mode: string) => void;
    setPilotControlsCurrent: (pilotControlsCurrent: string) => void;
    swipeableViewsIdxSet: (idx: number) => void;
    sceneSelected: string;
    onSceneSelectedChange: Dispatch<SetStateAction<string>>;
}

const PilotMode: React.FC<PilotModeProps> = ({
    cameraID,
    remoteStreams,
    isCameraVeilVisible,
    isCameraVeilVisibleSet,
    tabContent,
    activeMainGroupTab,
    setActiveMainGroupTab,
    setVelocityScale,
    setActionMode,
    setPilotControlsCurrent,
    swipeableViewsIdxSet,
    sceneSelected,
    onSceneSelectedChange,
}) => {
    const onActionSpeedChange = useCallback(
        (newSpeed: number) => {
            setVelocityScale(newSpeed);
            FunctionProvider.velocityScale = newSpeed;
        },
        [setVelocityScale]
    );

    const [isRadialCornerMenuOpen, setIsRadialCornerMenuOpen] = useState(false);
    const [activeCameraIcon, setActiveCameraIcon] = useState(cameraRight);

    // Options for the corner menu
    const menuOptions: RadialCornerMenuOption[] = [
        {
            iconSrc: cameraRight,
            label: "R",
            onClick: () => {
                pilotModeFunctionProvider.provideFunctions(
                    PilotModeFunctions.SetCameraRight
                )();
                setActiveCameraIcon(cameraRight);
                setIsRadialCornerMenuOpen(false);
                isCameraVeilVisibleSet(false);
            },
        },
        {
            iconSrc: cameraCenter,
            label: "C",
            onClick: () => {
                pilotModeFunctionProvider.provideFunctions(
                    PilotModeFunctions.SetCameraCenter
                )();
                setActiveCameraIcon(cameraCenter);
                setIsRadialCornerMenuOpen(false);
                isCameraVeilVisibleSet(false);
            },
        },
        {
            iconSrc: cameraLeft,
            label: "L",
            onClick: () => {
                pilotModeFunctionProvider.provideFunctions(
                    PilotModeFunctions.SetCameraLeft
                )();
                setActiveCameraIcon(cameraLeft);
                setIsRadialCornerMenuOpen(false);
                isCameraVeilVisibleSet(false);
            },
        },
    ];

    return (
        <div className="pilot-mode-wrapper">
            <div className="controls">
                <div className="simple-camera-view-wrapper_XP">
                    <SimpleCameraView
                        id={cameraID}
                        remoteStreams={remoteStreams}
                        isCameraVeilVisible={isCameraVeilVisible}
                    />
                </div>
                <AnimatePresence initial={false} mode="wait">
                    {!isCameraVeilVisible && (
                        <motion.div
                            key="main-group"
                            initial={{
                                opacity: 0,
                                filter: "blur(10px)",
                                y: 3,
                            }}
                            animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                            exit={{ opacity: 0, filter: "blur(10px)", y: 3 }}
                            transition={{
                                type: "spring",
                                duration: 1,
                                bounce: 0.2,
                            }}
                        >
                            <TabGroup
                                tabLabels={["Controls", "Recordings"]}
                                tabContent={tabContent}
                                startIdx={activeMainGroupTab}
                                onChange={(index: number) =>
                                    setActiveMainGroupTab(index)
                                }
                                pill={false}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
                {activeMainGroupTab === 0 && !isCameraVeilVisible && (
                    <>
                        {/* Camera Button (Left) */}
                        <div className="switch-camera-btn-container">
                            <button
                                className="switch-camera-btn"
                                type="button"
                                onClick={() => {
                                    setIsRadialCornerMenuOpen(true);
                                    isCameraVeilVisibleSet(true);
                                }}
                            >
                                <img src={activeCameraIcon} alt="Camera Menu" />
                            </button>
                        </div>
                    </>
                )}
                {/* Corner Menu - Outside the visibility check but controlled by its own state */}
                <RadialCornerMenu
                    isOpen={isRadialCornerMenuOpen}
                    onClose={() => {
                        setIsRadialCornerMenuOpen(false);
                        isCameraVeilVisibleSet(false);
                    }}
                    options={menuOptions}
                    selectedLabel={
                        activeCameraIcon === cameraLeft
                            ? "L"
                            : activeCameraIcon === cameraCenter
                              ? "C"
                              : activeCameraIcon === cameraRight
                                ? "R"
                                : undefined
                    }
                />
            </div>
            <FooterPilotMode
                // Pilot Controls
                pilotControlsCurrent={FunctionProvider.pilotControlsCurrent}
                setPilotControlsCurrent={setPilotControlsCurrent}
                // Action Speed
                actionSpeedCurrent={FunctionProvider.velocityScale}
                onActionSpeedChange={onActionSpeedChange}
                // Action Mode
                actionModeCurrent={FunctionProvider.actionMode}
                onActionModeChange={setActionMode}
                // Camera Veil
                isCameraVeilVisible={isCameraVeilVisible}
                isCameraVeilVisibleSet={isCameraVeilVisibleSet}
                // Swipeable Views
                swipeableViewsIdxSet={swipeableViewsIdxSet}
                // Scene Selection
                sceneSelected={sceneSelected}
                onSceneSelectedChange={onSceneSelectedChange}
            />
        </div>
    );
};

export default PilotMode;
