import { memo } from "react";

import "operator/css/BatteryGauge.css";
import batteryGauge from "operator/icons/Battery_Gauge.svg";
import React from "react";

export const BatteryGauge = memo(() => {
    return (
        <div className="battery-gauge-container">
            <img src={batteryGauge} className={"battery-gauge-image"} aria-disabled="true" />
        </div>
    );
});
