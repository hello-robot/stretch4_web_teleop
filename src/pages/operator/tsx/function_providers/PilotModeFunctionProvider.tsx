import { FunctionProvider } from "./FunctionProvider";

export enum PilotModeFunctions {
    SetCameraLeft,
    SetCameraCenter,
    SetCameraRight,
}

export class PilotModeFunctionProvider extends FunctionProvider {
    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
    }

    public provideFunctions(functionName: PilotModeFunctions) {
        switch (functionName) {
            case PilotModeFunctions.SetCameraLeft:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective("left");
                };
            case PilotModeFunctions.SetCameraCenter:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective(
                        "center"
                    );
                };
            case PilotModeFunctions.SetCameraRight:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective("right");
                };
        }
    }
}
