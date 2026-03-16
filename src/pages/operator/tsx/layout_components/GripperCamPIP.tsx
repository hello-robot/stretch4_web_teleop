import React from "react";
import { SimpleCameraView } from "./SimpleCameraView";
import { CameraViewId } from "../utils/component_definitions";
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import IconExpand from "operator/icons/IconExpand.svg";
import IconCollapse from "operator/icons/IconCollapse.svg";

import "../../css/GripperCamPIP.css";

interface GripperCamPIPProps {
    cameraID: CameraViewId;
    remoteStreams: any; // Replace 'any' with the actual type if known
    isCameraVeilVisible: boolean;
    isGripperCamPIPViz: boolean;
    isGripperCamPIPVizSet: React.Dispatch<React.SetStateAction<boolean>>;
    isGripperCamLarge: boolean;
    isGripperCamLargeSet: React.Dispatch<React.SetStateAction<boolean>>;
}

const GripperCamPIP: React.FC<GripperCamPIPProps> = ({
    cameraID,
    remoteStreams,
    isCameraVeilVisible,
    isGripperCamPIPViz,
    isGripperCamPIPVizSet,
    isGripperCamLarge,
    isGripperCamLargeSet
}) => {
    return (
        <div className={`gripper-cam-pip-wrapper ${isGripperCamPIPViz ? "" : "hidden"} ${isGripperCamLarge ? "large" : ""}`}>
            <div className="controls">
                <div className="simple-camera-view-wrapper_XP">
                    <SimpleCameraView
                        id={cameraID}
                        remoteStreams={remoteStreams}
                        isCameraVeilVisible={isCameraVeilVisible}
                    />
                </div>
            </div>
            <div className="button-grippercampip-wrapper">
                <button
                    className="button-grippercampip-toggle"
                    onPointerDown={() => isGripperCamPIPVizSet(!isGripperCamPIPViz)}
                    aria-label="Toggle"
                >
                    {
                        isGripperCamPIPViz ? <KeyboardArrowRightIcon /> : <KeyboardArrowLeftIcon />
                    }
                </button>
                <button
                    className="button-grippercampip-size-toggle"
                    onPointerDown={() => isGripperCamLargeSet(!isGripperCamLarge)}
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
