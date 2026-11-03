import checkOff from "home/public/icons/check-off.svg";
import checkOn from "home/public/icons/check-on.svg";
import React from "react";
import {
    CardTone,
    FEATURE_FLAGS,
    effectiveFlag,
    featureLabel,
    RobotRecord,
} from "../robotModel";

/**
 * One row per flag in features.json. The check lights up only when the flag is
 * on and the robot is reachable; the label dims whenever the flag is off.
 */
export const ConfigChecklist = ({ robot, tone }: { robot: RobotRecord; tone: CardTone }) => (
    <ul className="hr-checklist">
        {Object.keys(FEATURE_FLAGS).map((flag) => {
            const enabled = effectiveFlag(robot, flag);
            const lit = enabled && tone === "lit";
            return (
                <li key={flag} className="hr-checklist__row">
                    <img alt="" className="hr-checklist__icon" src={lit ? checkOn : checkOff} />
                    <span className={`hr-checklist__label${enabled ? "" : " hr-checklist__label--off"}`}>
                        {featureLabel(flag)}
                    </span>
                </li>
            );
        })}
    </ul>
);
