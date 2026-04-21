import { FunctionProvider } from "./FunctionProvider";

export enum CameraSwitcherFunctions {
    SetCameraLeft,
    SetCameraCenter,
    SetCameraRight,
}

export class CameraSwitcherFunctionProvider extends FunctionProvider {
    constructor() {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
    }

    public provideFunctions(functionName: CameraSwitcherFunctions) {
        switch (functionName) {
            case CameraSwitcherFunctions.SetCameraLeft:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective("left");
                };
            case CameraSwitcherFunctions.SetCameraCenter:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective(
                        "center"
                    );
                };
            case CameraSwitcherFunctions.SetCameraRight:
                return () => {
                    FunctionProvider.remoteRobot?.setCameraPerspective("right");
                };
        }
    }
}
