import { ActionState, ROSPose } from "shared/util";
import { MapFunction } from "../layout_components/AutoNav";
import { FunctionProvider } from "./FunctionProvider";
import { occupancyGrid, underMapFunctionProvider } from "operator/tsx/index";

export class MapFunctionProvider extends FunctionProvider {
    private operatorCallback?: (state: ActionState) => void = undefined;

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
            case MapFunction.GoalReached:
                return () => {
                    let goalReached =
                        FunctionProvider.remoteRobot?.isGoalReached();
                    if (goalReached) {
                        FunctionProvider.remoteRobot?.setGoalReached(false);
                        return true;
                    }
                    return false;
                };
            case MapFunction.SeedLocalization:
                return () => {
                    FunctionProvider.remoteRobot?.seedLocalization();
                };
        }
    }
}
