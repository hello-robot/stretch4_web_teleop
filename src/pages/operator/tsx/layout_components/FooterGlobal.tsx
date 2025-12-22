import React, { useState } from "react";
import "operator/css/FooterGlobal.css";
import batteryIcon from "operator/icons/Battery_Footer.svg";
import runStopRunIcon from "operator/icons/RunStop_Run.svg";
import runStopStopIcon from "operator/icons/RunStop_Stop.svg";

interface FooterGlobalProps {}

const FooterGlobal: React.FC<FooterGlobalProps> = ({}) => {
    const [isStopped, isStoppedSet] = useState<boolean>(false);

    return (
        <>
            <div className="battery-container">
                <img src={batteryIcon} alt="Battery" className="battery" />
            </div>
            <div className="scene-menu-button-container">
                <button
                    className="scene-menu-button"
                    onClick={() => console.log("SceneMenu toggled.")}
                >
                    Pilot Mode
                    <div className="fancy-border" />
                </button>
            </div>
            <div className="run-stop-container">
                <button
                    onClick={() => isStoppedSet(!isStopped)}
                    className={`run-stop-button ${isStopped ? "stopped" : "running"}`}
                >
                    <img
                        src={isStopped ? runStopStopIcon : runStopRunIcon}
                        alt={isStopped ? "Stop" : "Run"}
                        className="icon"
                    />
                </button>
            </div>
        </>
    );
};

export default FooterGlobal;
