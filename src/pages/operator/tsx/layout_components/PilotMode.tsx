import React, { useState, useCallback } from "react";
import { SimpleCameraView } from "./SimpleCameraView";
import { TabGroup } from "../basic_components/TabGroup";
import FooterPilotMode from "./FooterPilotMode";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import { CameraViewId } from "../utils/component_definitions";
import { AnimatePresence, motion } from "framer-motion";
import "../../css/PilotMode.css";

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
}) => {
    const onActionSpeedChange = useCallback(
        (newSpeed: number) => {
            setVelocityScale(newSpeed);
            FunctionProvider.velocityScale = newSpeed;
        },
        [setVelocityScale]
    );

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
            />
        </div>
    );
};

export default PilotMode;
