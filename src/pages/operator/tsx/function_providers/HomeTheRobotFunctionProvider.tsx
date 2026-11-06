import { FunctionProvider } from "./FunctionProvider";
import { HomeTheRobotFunction } from "../basic_components/HomingBanner";
import { ActionState } from "shared/util";

export class HomeTheRobotFunctionProvider extends FunctionProvider {
    private driverMode: string;
    private modeIsHomingCallback: (mode: boolean) => void;
    private isHomed: boolean;
    private isHomedCallback: (isHomed: boolean) => void;
    private homingResultCallback?: (result: ActionState) => void;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.updateModeState = this.updateModeState.bind(this);
        this.updateIsHomedState = this.updateIsHomedState.bind(this);
        this.updateHomingResult = this.updateHomingResult.bind(this);
    }

    /**
     * Records a callback from the component. The callback is called
     * with whether the driver's mode is "homing"
     *
     * @param callback callback to component
     */
    public setModeIsHomingCallback(callback: (mode: boolean) => void) {
        this.modeIsHomingCallback = callback;
    }

    public updateModeState(mode: string): void {
        this.driverMode = mode;
        if (this.modeIsHomingCallback)
            this.modeIsHomingCallback(this.driverMode == "homing");
    }

    /**
     * Records a callback from Operator.tsx. The callback is called
     * with whether the robot is homed
     *
     * @param callback callback to operator
     */
    public setIsHomedCallback(callback: (mode: boolean) => void) {
        this.isHomedCallback = callback;
    }

    public updateIsHomedState(isHomed: boolean): void {
        this.isHomed = isHomed;
        if (this.isHomedCallback) this.isHomedCallback(this.isHomed);
    }

    /**
     * Records a callback invoked when the /home_the_robot service returns
     * (success or failure, e.g. rejected because the robot is runstopped).
     *
     * @returns unsubscribe function
     */
    public setHomingResultCallback(callback: (result: ActionState) => void) {
        this.homingResultCallback = callback;
        return () => {
            if (this.homingResultCallback === callback)
                this.homingResultCallback = undefined;
        };
    }

    public updateHomingResult(result: ActionState): void {
        this.homingResultCallback?.(result);
    }

    public provideFunctions(homeTheRobotFunction: HomeTheRobotFunction) {
        switch (homeTheRobotFunction) {
            case HomeTheRobotFunction.Home:
                return () => {
                    FunctionProvider.remoteRobot?.homeTheRobot();
                };
        }
    }
}
