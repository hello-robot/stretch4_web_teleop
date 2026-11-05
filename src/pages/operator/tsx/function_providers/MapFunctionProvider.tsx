import { ActionState, ROSPose } from "shared/util";
import { MapFunction } from "../layout_components/AutoNav";
import { FunctionProvider } from "./FunctionProvider";
import { occupancyGrid, underMapFunctionProvider } from "operator/tsx/index";

export class MapFunctionProvider extends FunctionProvider {
    private operatorCallback?: (state: ActionState) => void = undefined;
    private autoDockCallback?: (state: ActionState) => void = undefined;

    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        FunctionProvider.remoteRobot?.getOccupancyGrid("getOccupancyGrid");
    }

    public setSeedLocalizationState(state: ActionState) {
        if (this.operatorCallback) this.operatorCallback(state);
    }

    public setOperatorCallback(callback: (state: ActionState) => void) {
        this.operatorCallback = callback;
    }

    /**
     * Forward an autonomous docking state update to the registered UI callback.
     *
     * Args:
     *     state: ActionState containing status message and alert type.
     *
     * Returns:
     *     None.
     */
    public setAutoDockState(state: ActionState): void {
        if (this.autoDockCallback) this.autoDockCallback(state);
    }

    /**
     * Register a callback invoked when autonomous docking state updates arrive.
     *
     * Args:
     *     callback: Handler receiving the updated ActionState.
     *
     * Returns:
     *     None.
     */
    public setAutoDockCallback(callback: (state: ActionState) => void): void {
        this.autoDockCallback = callback;
    }

    /**
     * Return a handler function or data reference for the requested map action.
     *
     * Args:
     *     mapFunction: MapFunction identifier specifying the operation to bind.
     *
     * Returns:
     *     Callable action handler or occupancy grid reference.
     */
    public provideFunctions(mapFunction: MapFunction) {
        switch (mapFunction) {
            case MapFunction.GetMap:
                return occupancyGrid;
            case MapFunction.GetPose:
                return () => {
                    return FunctionProvider.remoteRobot?.getMapPose();
                };
            case MapFunction.MoveBase:
                return (pose: ROSPose) => {
                    underMapFunctionProvider.setMoveBaseState({
                        state: "Navigation executing!",
                        alert_type: "info",
                    });
                    // FunctionProvider.remoteRobot?.stopExecution()
                    FunctionProvider.remoteRobot?.moveBase(pose);
                };
            case MapFunction.SeedLocalization:
                return () => {
                    FunctionProvider.remoteRobot?.seedLocalization();
                };
            case MapFunction.AutoDock:
                return () => {
                    FunctionProvider.remoteRobot?.autoDock();
                };
            case MapFunction.StopAutoDock:
                return () => {
                    FunctionProvider.remoteRobot?.stopAutoDock();
                };
        }
    }
}
