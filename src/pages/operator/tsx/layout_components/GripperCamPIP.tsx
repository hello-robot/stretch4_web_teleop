import React from "react";
import { motion } from "framer-motion";
import { SimpleCameraView } from "./SimpleCameraView";
import { CameraViewId } from "../utils/component_definitions";
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import IconExpand from "operator/icons/IconExpand.svg";
import IconCollapse from "operator/icons/IconCollapse.svg";

import "../../css/GripperCamPIP.css";

/** Border radius lives in `style` so framer-motion can correct it mid-layout-animation. */
const FRAME_BORDER_RADIUS_PX = 12;

const FRAME_LAYOUT_TRANSITION = {
    type: "spring",
    duration: 0.65,
    bounce: 0.15,
} as const;

interface GripperCamPIPProps {
    cameraID: CameraViewId;
    remoteStreams: any; // Replace 'any' with the actual type if known
    isCameraVeilVisible: boolean;
    isGripperCamPIPViz: boolean;
    isGripperCamPIPVizSet: React.Dispatch<React.SetStateAction<boolean>>;
    isGripperCamLarge: boolean;
    isGripperCamLargeSet: React.Dispatch<React.SetStateAction<boolean>>;
    homingBannerDismissed: boolean;
    isFlyingGripper: boolean;
    onEnterFlyingGripper: () => void;
}

const GripperCamPIP: React.FC<GripperCamPIPProps> = ({
    cameraID,
    remoteStreams,
    isCameraVeilVisible,
    isGripperCamPIPViz,
    isGripperCamPIPVizSet,
    isGripperCamLarge,
    isGripperCamLargeSet,
    homingBannerDismissed,
    isFlyingGripper,
    onEnterFlyingGripper,
}) => {
    const isVisible = isGripperCamPIPViz && homingBannerDismissed;
    const canEnterFlyingGripper = isVisible && !isFlyingGripper;

    const wrapperClassName = [
        "gripper-cam-pip-wrapper",
        isVisible ? "" : "hidden",
        isGripperCamLarge ? "large" : "",
        isFlyingGripper ? "flying" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={wrapperClassName}>
            <div className="controls">
                <div className="simple-camera-view-wrapper_XP">
                    <motion.div
                        layout
                        transition={FRAME_LAYOUT_TRANSITION}
                        className="gripper-cam-frame"
                        style={{ borderRadius: FRAME_BORDER_RADIUS_PX }}
                        onPointerDown={
                            canEnterFlyingGripper ? onEnterFlyingGripper : undefined
                        }
                        role={canEnterFlyingGripper ? "button" : undefined}
                        aria-label={
                            canEnterFlyingGripper ? "Open flying gripper" : undefined
                        }
                    >
                        <SimpleCameraView
                            id={cameraID}
                            remoteStreams={remoteStreams}
                            isCameraVeilVisible={isCameraVeilVisible}
                        />
                    </motion.div>
                </div>
            </div>
            <div
                className="button-grippercampip-wrapper"
                aria-hidden={isFlyingGripper}
            >
                <button
                    className="button-grippercampip-toggle"
                    onPointerDown={() => isGripperCamPIPVizSet(!isGripperCamPIPViz)}
                    disabled={isFlyingGripper}
                    aria-label="Toggle"
                >
                    {
                        isGripperCamPIPViz ? <KeyboardArrowRightIcon /> : <KeyboardArrowLeftIcon />
                    }
                </button>
                <button
                    className="button-grippercampip-size-toggle"
                    onPointerDown={() => isGripperCamLargeSet(!isGripperCamLarge)}
                    disabled={!isGripperCamPIPViz || isFlyingGripper}
                    aria-label="Change size"
                >
                    {
                        !isGripperCamLarge
                            ? <img src={IconExpand} />
                            : <img src={IconCollapse} />
                    }
                </button>

            </div>
        </div>
    );
};

export default GripperCamPIP;
