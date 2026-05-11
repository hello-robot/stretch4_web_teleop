import React, { useState, useCallback, useRef, useEffect } from "react";
import Check from "@mui/icons-material/Check";
import spinnerCalibrationWhite from "operator/icons/Spinner_Calibration.svg";
import spinnerCalibrationPrimary from "operator/icons/Spinner_Calibration_Primary.svg";
import { homeTheRobotFunctionProvider } from "../index";
import Ellipsis from "./Ellipsis";
import "operator/css/HomingBanner.css";

const SUCCESS_DURATION = 2000;

/** All the possible button functions */
export enum HomeTheRobotFunction {
    Home,
}

export interface HomeTheRobotFunctions {
    Home: () => void;
}

export interface HomingBannerProps {
    robotIsHomed: boolean;
    /** Fired whenever the banner finishes showing the success strip and applies full dismiss (`fullyDismissed`). */
    homingBannerDismissedSet?: (fullyDismissed: boolean) => void;
}

export const HomingBanner = (props: HomingBannerProps) => {

    // State to track if the robot is calibrating
    const [isCalibrating, isCalibratingSet] = useState(false);

    // After homing completes, keep the banner visible for a success strip until this is true
    const [fullyDismissed, fullyDismissedSet] = useState(props.robotIsHomed);

    // Refs to track the calibration process
    const calibratingRef = useRef(false);

    // Ref to the container element (for focus containment when hiding)
    const containerRef = useRef<HTMLDivElement>(null);

    // Previous `robotIsHomed` to detect false → true (start success timer only on transition)
    const prevHomedRef = useRef(props.robotIsHomed);

    // When the user clicks the home button, start the calibration process
    const home = useCallback(() => {
        if (calibratingRef.current) {
            return;
        }
        calibratingRef.current = true;
        isCalibratingSet(true);
        homeTheRobotFunctionProvider.provideFunctions(HomeTheRobotFunction.Home)!();
    }, []);

    // When `robotIsHomed` updates: reset UI if un-homed; on first homing completion blur focus,
    // then show success for 2s before applying dismiss (`fullyDismissed`) styles
    useEffect(() => {
        if (!props.robotIsHomed) {
            prevHomedRef.current = false;
            fullyDismissedSet(false);
            calibratingRef.current = false;
            isCalibratingSet(false);
            return;
        }

        calibratingRef.current = false;
        isCalibratingSet(false);
        const root = containerRef.current;
        if (root?.contains(document.activeElement)) {
            (document.activeElement as HTMLElement).blur();
        }

        const wasHomed = prevHomedRef.current;
        prevHomedRef.current = true;

        if (wasHomed) {
            return;
        }

        setTimeout(() => {
            fullyDismissedSet(true);
        }, SUCCESS_DURATION);
    }, [props.robotIsHomed]);

    useEffect(() => {
        props.homingBannerDismissedSet?.(fullyDismissed);
    }, [fullyDismissed, props.homingBannerDismissedSet]);

    const showSuccess = props.robotIsHomed && !fullyDismissed;
    // Apply exit / inert styles only after success strip (or on load if already homed)
    const homedForCss = fullyDismissed;

    // Calc the CSS classes to apply to container
    const containerMods = homedForCss
        ? " homing-banner-container--homed"
        : showSuccess
            ? " homing-banner-container--success"
            : isCalibrating && !props.robotIsHomed
                ? " homing-banner-container--calibrating"
                : "";

    // Calc the CSS classes to apply to panel
    const bannerMods = homedForCss
        ? " homing-banner--homed"
        : showSuccess
            ? " homing-banner--success"
            : isCalibrating
                ? " homing-banner--calibrating"
                : "";

    // Calc the CSS classes to apply to button
    let buttonMods = "";
    if (showSuccess) {
        buttonMods = " homing-btn--success";
    } else if (isCalibrating) {
        buttonMods = " homing-btn--calibrating";
    }

    return (
        <div
            ref={containerRef}
            className={"homing-banner-container" + containerMods}
            {...(homedForCss ? { "aria-hidden": true, inert: "" } : {})}
        >
            <div className={"homing-banner" + bannerMods}>
                <div className="copywriting">
                    <div className="heading">Calibration required</div>
                    <div className="subheading">
                        Please ensure Stretch has a 2ft clearance area in front its base.
                    </div>
                </div>
                <div className="homing-btn-ghost" />
            </div>
            {/* CTA button */}
            <button
                type="button"
                className={"homing-btn" + buttonMods}
                onClick={home}
                disabled={isCalibrating || showSuccess || homedForCss}
                aria-busy={!homedForCss && isCalibrating}
                tabIndex={homedForCss ? -1 : undefined}
            >
                {/* CTA copywriting (idle / calibrating / success) */}
                {showSuccess ? (
                    <div className="homing-btn-success-row">
                        <span className="homing-btn-success-text" aria-live="polite">
                            Calibration complete!
                        </span>
                        <Check className="homing-btn-success-icon" aria-hidden />
                    </div>
                ) : isCalibrating ? (
                    <>
                        <span>
                            Calibrating
                            <Ellipsis />
                        </span>
                    </>
                ) : (
                    <>
                        <span>Start calibration</span>
                    </>
                )}
                {/* Preload spinners so they don't "flash" into DOM (hidden during success) */}
                {!showSuccess && (
                    <span className="homing-btn-spinner-wrap" aria-hidden>
                        <img
                            src={spinnerCalibrationWhite}
                            alt=""
                            className={
                                "homing-btn-spinner" +
                                (isCalibrating ? "" : " homing-btn-spinner--active")
                            }
                        />
                        <img
                            src={spinnerCalibrationPrimary}
                            alt=""
                            className={
                                "homing-btn-spinner" +
                                (isCalibrating
                                    ? " homing-btn-spinner--active is-animating"
                                    : "")
                            }
                        />
                    </span>
                )}
            </button>
        </div>
    );
};
