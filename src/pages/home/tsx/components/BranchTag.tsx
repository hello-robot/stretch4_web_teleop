import tagOffline from "home/public/icons/tag-offline.svg";
import tagOnline from "home/public/icons/tag-online.svg";
import React from "react";
import { CardTone } from "../robotModel";

const TAG_ICON: Record<CardTone, string> = { lit: tagOnline, dim: tagOffline };

/**
 * What the robot reports it is running, with buildTitle explaining where it
 * leads.
 *
 * @param props.branch Label to show: the robot's describe or its branch.
 * @param props.title Tooltip explaining which interface the card opens.
 * @param props.tone Whether the card is lit or dim.
 * @param props.dirty Whether the checkout is not a release, which colours
 *     the label red.
 * @returns The tag row, or null when there is no label to show.
 */
export const BranchTag = ({
    branch,
    title,
    tone,
    dirty = false,
}: {
    branch: string;
    title: string;
    tone: CardTone;
    dirty?: boolean;
}) => {
    if (!branch) return null;
    return (
        <div
            className={`hr-branch hr-branch--${tone}${dirty ? " hr-branch--dirty" : ""}`}
            title={title}
        >
            <img alt="" className="hr-branch__icon" src={TAG_ICON[tone]} />
            <span className="hr-branch__name">{branch}</span>
        </div>
    );
};
