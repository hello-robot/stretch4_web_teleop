import "operator/css/RunStopButton.css";
import { className } from "shared/util";
import { runStopFunctionProvider } from "..";
import { RunStopFunctions } from "../function_providers/RunStopFunctionProvider";
import { CustomizableComponentProps } from "../layout_components/CustomizableComponent";
import runStopButton from "operator/icons/button.svg";
import React, { useState } from "react";

export const RunStopButton = (props: CustomizableComponentProps) => {
    const functs: RunStopFunctions = runStopFunctionProvider.provideFunctions();
    const [enabled, setEnabled] = useState<boolean>(false);

    runStopFunctionProvider.setRunStopStateChangeCallback(setEnabled);

    return (
        <div className="runStopContainer">
            <button
                type="button"
                onClick={functs.onClick}
                className={className("run-stop-button", { enabled })}
                aria-label={enabled ? "Disable run stop" : "Enable run stop"}
                aria-pressed={enabled}
            >
                <img src={runStopButton} alt="" aria-hidden="true" />
            </button>
            {enabled ? (
                <span>Run Stop: Enabled</span>
            ) : (
                <span>Run Stop: Disabled</span>
            )}
        </div>
    );
};
