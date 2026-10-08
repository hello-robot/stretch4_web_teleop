import configIcon from "home/public/icons/config.svg";
import Switch from "@mui/material/Switch";
import React from "react";
import { effectiveFlag, FEATURE_FLAGS, featureLabel, RobotRecord } from "../robotModel";
import { BottomSheet } from "./BottomSheet";

interface ConfigSheetProps {
    open: boolean;
    robot: RobotRecord;
    onClose: () => void;
    onToggle: (flag: string, enabled: boolean) => void;
}

/** Toggles apply on the robot's next launch; the daemon reads them from RTDB. */
export const ConfigSheet = ({ open, robot, onClose, onToggle }: ConfigSheetProps) => (
    <BottomSheet open={open} title="Config" icon={configIcon} onClose={onClose}>
        <ul className="hr-sheet__list">
            {Object.entries(FEATURE_FLAGS).map(([flag, entry]) => {
                const enabled = effectiveFlag(robot, flag);
                return (
                    <li key={flag}>
                        <label className="hr-sheet__option">
                            <span className="hr-sheet__option-text" style={{ flex: 1 }}>
                                <span>{featureLabel(flag)}</span>
                                {entry.description && (
                                    <span className="hr-sheet__option-desc">{entry.description}</span>
                                )}
                            </span>
                            <Switch
                                checked={enabled}
                                onChange={(_, checked) => onToggle(flag, checked)}
                                inputProps={{ "aria-label": featureLabel(flag) }}
                            />
                        </label>
                    </li>
                );
            })}
        </ul>
        <p className="hr-sheet__option-desc" style={{ marginTop: 16 }}>
            Changes take effect the next time Web Teleop is launched on this robot.
        </p>
    </BottomSheet>
);
