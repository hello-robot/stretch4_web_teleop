import React, { useEffect, useRef, useState } from "react";
import { loginHandler } from "../index";

const STICK_THRESHOLD_PX = 24;

interface LaunchLogPanelProps {
    fleetId: string;
}

/** Scrolling tail of `launch_logs/<fleetId>`, with copy for the full text. */
export const LaunchLogPanel = ({ fleetId }: LaunchLogPanelProps) => {
    const [text, textSet] = useState("");
    const [copied, copiedSet] = useState(false);
    const scrollerRef = useRef<HTMLPreElement>(null);
    const stickRef = useRef(true);

    useEffect(() => {
        return loginHandler.watchLaunchLog(fleetId, textSet);
    }, [fleetId]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller || !stickRef.current) return;
        scroller.scrollTop = scroller.scrollHeight;
    }, [text]);

    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => copiedSet(false), 1500);
        return () => window.clearTimeout(timer);
    }, [copied]);

    const onScroll = () => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        stickRef.current = distance < STICK_THRESHOLD_PX;
    };

    const copy = () => {
        const payload = text;
        const done = () => copiedSet(true);
        if (!navigator.clipboard?.writeText) return;
        navigator.clipboard.writeText(payload).then(done).catch(() => {});
    };

    return (
        <div className="hr-launch-log">
            <div className="hr-launch-log__bar">
                <button
                    type="button"
                    className="hr-launch-log__copy"
                    onClick={copy}
                    aria-label="Copy logs to clipboard"
                >
                    {copied ? "Copied" : "Copy to clipboard"}
                </button>
            </div>
            <pre
                ref={scrollerRef}
                className="hr-launch-log__text"
                onScroll={onScroll}
            >
                {text || "Waiting for logs…"}
            </pre>
        </div>
    );
};
