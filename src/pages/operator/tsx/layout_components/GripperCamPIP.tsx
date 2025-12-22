import React from "react";
import { SimpleCameraView } from "./SimpleCameraView";
import { CameraViewId } from "../utils/component_definitions";
import "../../css/GripperCamPIP.css";

interface GripperCamPIPProps {
    cameraID: CameraViewId;
    remoteStreams: any; // Replace 'any' with the actual type if known
    isCameraVeilVisible: boolean;
}

const GripperCamPIP: React.FC<GripperCamPIPProps> = ({
    cameraID,
    remoteStreams,
    isCameraVeilVisible,
}) => {
    return (
        <div className="gripper-cam-pip-wrapper">
            <div className="controls">
                <div className="simple-camera-view-wrapper_XP">
                    <SimpleCameraView
                        id={cameraID}
                        remoteStreams={remoteStreams}
                        isCameraVeilVisible={isCameraVeilVisible}
                    />
                </div>
            </div>
        </div>
    );
};

export default GripperCamPIP;
