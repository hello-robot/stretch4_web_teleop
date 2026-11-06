import tagOffline from "home/public/icons/tag-offline.svg";
import tagOnline from "home/public/icons/tag-online.svg";
import React from "react";
import { CardTone } from "../robotModel";

const TAG_ICON: Record<CardTone, string> = { lit: tagOnline, dim: tagOffline };

/** What the robot reports it is running, with buildTitle explaining where it leads. */
export const BranchTag = ({
    branch,
    title,
    tone,
}: {
    branch: string;
    title: string;
    tone: CardTone;
}) => {
    if (!branch) return null;
    return (
        <div className={`hr-branch hr-branch--${tone}`} title={title}>
            <img alt="" className="hr-branch__icon" src={TAG_ICON[tone]} />
            <span className="hr-branch__name">{branch}</span>
        </div>
    );
};
