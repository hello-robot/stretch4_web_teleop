import { FunctionProvider } from "./FunctionProvider";
import { HomeTheRobotFunction } from "../basic_components/HomingBanner";

export class HomeTheRobotFunctionProvider extends FunctionProvider {
    private driverMode: string;
    private driverModeCallback?: (mode: string) => void;
    private isHomed: boolean;
    private isHomedCallback: (isHomed: boolean) => void;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.updateModeState = this.updateModeState.bind(this);
        this.updateIsHomedState = this.updateIsHomedState.bind(this);
    }

    /**
     * Records a callback from the component. The callback is called
     * with the driver's mode
     *
     * @param callback callback to component
     * @returns function to remove the callback
     */
    public setDriverModeCallback(callback: (mode: string) => void): () => void {
        this.driverModeCallback = callback;
        if (this.driverMode !== undefined) callback(this.driverMode);
        return () => {
            if (this.driverModeCallback === callback)
                this.driverModeCallback = undefined;
        };
    }

    public updateModeState(mode: string): void {
        this.driverMode = mode;
        this.driverModeCallback?.(this.driverMode);
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

    public provideFunctions(homeTheRobotFunction: HomeTheRobotFunction) {
        switch (homeTheRobotFunction) {
            case HomeTheRobotFunction.Home:
                return () => {
                    FunctionProvider.remoteRobot?.homeTheRobot();
                };
        }
    }
}
