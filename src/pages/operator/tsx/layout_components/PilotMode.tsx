import React, { useCallback } from "react";
import { SimpleCameraView } from "./SimpleCameraView";
import { TabGroup } from "../basic_components/TabGroup";
import FooterPilotMode from "./FooterPilotMode";
import { FunctionProvider } from "../function_providers/FunctionProvider";
import { CameraViewId } from "../utils/component_definitions";
import { AnimatePresence, motion } from "framer-motion";
import { MovementRecorder } from "./MovementRecorder";
import { SharedState } from "./CustomizableComponent";
import { PilotControlsToggle } from "../static_components/PilotControlsToggle";
import FlyingGripperPad from "../static_components/FlyingGripperPad";
import "../../css/PilotMode.css";

const PAD_SWAP_TRANSITION = { duration: 0.3, ease: "easeOut" } as const;

interface PilotModeProps {
    cameraID: CameraViewId;
    remoteStreams: any; // Replace 'any' with the actual type if known
    isCameraVeilVisible: boolean;
    isCameraVeilVisibleSet: (visible: boolean) => void;
    tabContent: ((active: boolean) => React.JSX.Element)[];
    activeMainGroupTab: number;
    setActiveMainGroupTab: (index: number) => void;
    onVelocityScaleChange: (scale: number) => void;
    setActionMode: (mode: string) => void;
    setPilotControlsCurrent: (pilotControlsCurrent: string) => void;
    swipeableViewsIdxSet: (idx: number) => void;
    setCameraID: (id: CameraViewId) => void;
    sceneSelected: string;
    onSceneSelectedChange: React.Dispatch<React.SetStateAction<string>>;
    globalRecord?: boolean;
    sharedState?: SharedState;
    isFlyingGripper: boolean;
    onExitFlyingGripper: () => void;
}

const PilotMode: React.FC<PilotModeProps> = ({
    cameraID,
    remoteStreams,
    isCameraVeilVisible,
    isCameraVeilVisibleSet,
    tabContent,
    activeMainGroupTab,
    setActiveMainGroupTab,
    onVelocityScaleChange,
    setActionMode,
    setPilotControlsCurrent,
    swipeableViewsIdxSet,
    setCameraID,
    sceneSelected,
    onSceneSelectedChange,
    sharedState,
    isFlyingGripper,
    onExitFlyingGripper,
}) => {
    const [isRecording, isRecordingSet] = React.useState<boolean>(false);

    const wrapperClassName = [
        "pilot-mode-wrapper",
        isRecording ? "is-recording" : "",
        isFlyingGripper ? "is-flying-gripper" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={wrapperClassName}>
            <div className="controls">
                <div className="simple-camera-view-wrapper_XP">
                    <SimpleCameraView
                        id={CameraViewId.overhead}
                        remoteStreams={remoteStreams}
                        isCameraVeilVisible={isCameraVeilVisible}
                    />
                </div>
                <AnimatePresence initial={false} mode="wait">
                    {!isCameraVeilVisible && (
                        <motion.div
                            key="main-group"
                            initial={{
                                position: 'absolute',
                                top: 0,
                                width: '100%',
                                height: '100%',
                                opacity: 0,
                                filter: "blur(10px)",
                                y: 3,
                            }}
                            animate={{
                                zIndex: 2,
                                position: 'absolute',
                                top: 0,
                                width: '100%',
                                height: '100%',
                                opacity: 1,
                                filter: "blur(0px)",
                                y: 0
                            }}
                            exit={{
                                position: 'absolute',
                                top: 0,
                                width: '100%',
                                height: '100%',
                                opacity: 0,
                                filter: "blur(10px)",
                                y: 3
                            }}
                            transition={{
                                type: "spring",
                                duration: 1,
                                bounce: 0.2,
                                filter: { type: "tween", duration: 0.3, ease: "easeOut" }
                            }}
                        >
                            <AnimatePresence initial={false} mode="wait">
                                {isFlyingGripper ? (
                                    <motion.div
                                        key="flying-gripper-pad"
                                        className="pilot-mode-pad-slot"
                                        initial={{ opacity: 0, y: 24 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: 24 }}
                                        transition={PAD_SWAP_TRANSITION}
                                    >
                                        <FlyingGripperPad
                                            onClose={onExitFlyingGripper}
                                            sharedState={sharedState}
                                        />
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="pilot-pad"
                                        className="pilot-mode-pad-slot"
                                        initial={{ opacity: 0, y: 24 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: 24 }}
                                        transition={PAD_SWAP_TRANSITION}
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
                        </motion.div>
                    )}
                </AnimatePresence>
                {/* Movement Recorder button <MovementRecordButton */}
                <MovementRecorder
                    sharedState={sharedState}
                    isCameraVeilVisible={isCameraVeilVisible}
                    setCameraVeilCallback={isCameraVeilVisibleSet}
                    isRecording={isRecording}
                    isRecordingSet={isRecordingSet}
                    hideButton={isFlyingGripper}
                />

                <PilotControlsToggle
                    onChange={setPilotControlsCurrent}
                    isCameraVeilVisible={isCameraVeilVisible || isFlyingGripper}
                    pilotControlsCurrent={
                        FunctionProvider.pilotControlsCurrent
                    }
                />
            </div>
            <FooterPilotMode
                cameraID={cameraID}
                setCameraID={setCameraID}
                // Action Speed
                actionSpeedCurrent={FunctionProvider.velocityScale}
                onActionSpeedChange={onVelocityScaleChange}
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
        </div >
    );
};

export default PilotMode;
