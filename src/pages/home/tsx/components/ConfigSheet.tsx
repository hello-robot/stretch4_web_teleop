import configIcon from "home/public/icons/config.svg";
import Switch from "@mui/material/Switch";
import React from "react";
import {
    effectiveFlag,
    FEATURE_FLAGS,
    featureLabel,
    RobotRecord,
} from "../robotModel";
import { BottomSheet } from "./BottomSheet";
import { SheetActions } from "./SheetActions";

interface ConfigSheetProps {
    open: boolean;
    robot: RobotRecord;
    interfaceActive: boolean;
    occupiedBy: string | null;
    busy: boolean;
    onClose: () => void;
    onApply: (changes: Record<string, boolean>) => void;
}

/**
 * Flag edits are staged rather than written per toggle, so Discard can leave a
 * running interface untouched. The daemon reads config once per launch, so an
 * apply against a running interface has to relaunch it -- otherwise the card
 * would describe values the robot is not using.
 */
export const ConfigSheet = ({
    open,
    robot,
    interfaceActive,
    occupiedBy,
    busy,
    onClose,
    onApply,
}: ConfigSheetProps) => {
    const [draft, draftSet] = React.useState<Record<string, boolean>>({});

    // Re-seed on every open so a discarded edit never reappears later.
    React.useEffect(() => {
        if (open) draftSet({});
    }, [open]);

    const changes = Object.fromEntries(
        Object.entries(draft).filter(
            ([flag, value]) => value !== effectiveFlag(robot, flag)
        )
    );

    return (
        <BottomSheet
            open={open}
            title="Config"
            icon={configIcon}
            onClose={onClose}
        >
            <ul className="hr-sheet__list">
                {Object.entries(FEATURE_FLAGS).map(([flag, entry]) => {
                    const enabled = draft[flag] ?? effectiveFlag(robot, flag);
                    return (
                        <li key={flag}>
                            <label className="hr-sheet__option">
                                <span
                                    className="hr-sheet__option-text"
                                    style={{ flex: 1 }}
                                >
                                    <span>{featureLabel(flag)}</span>
                                    {entry.description && (
                                        <span className="hr-sheet__option-desc">
                                            {entry.description}
                                        </span>
                                    )}
                                </span>
                                <Switch
                                    checked={enabled}
                                    onChange={(_, checked) =>
                                        draftSet((d) => ({
                                            ...d,
                                            [flag]: checked,
                                        }))
                                    }
                                    inputProps={{
                                        "aria-label": featureLabel(flag),
                                    }}
                                />
                            </label>
                        </li>
                    );
                })}
            </ul>

            <SheetActions
                interfaceActive={interfaceActive}
                occupiedBy={occupiedBy}
                busy={busy}
                onDiscard={onClose}
                onApply={() => onApply(changes)}
            />
        </BottomSheet>
    );
};
