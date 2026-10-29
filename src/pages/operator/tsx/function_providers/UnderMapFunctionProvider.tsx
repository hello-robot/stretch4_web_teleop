import { Transform, Vector3 } from "roslib";
import { ActionState, ROSPose } from "shared/util";
import { StorageHandler } from "../storage_handler/StorageHandler";
import { FunctionProvider } from "./FunctionProvider";

export enum UnderMapButton {
    SelectGoal,
    DeleteGoal,
    DeleteMapPose,
    CancelGoal,
    SaveGoal,
    LoadGoal,
    NavigateToPose,
    GetPose,
    GetSavedPoseNames,
    GetSavedPoseTypes,
    GetSavedPoses,
    RenamePose,
}

export class UnderMapFunctionProvider extends FunctionProvider {
    private selectGoal: boolean;
    private isMoveBaseActive: boolean = false;
    private storageHandler: StorageHandler;
    private mapPoseCallback?: (pose: Vector3) => void = undefined;
    private operatorCallback?: (state: ActionState) => void = undefined;

    constructor(storageHandler: StorageHandler) {
        super();
        this.provideFunctions = this.provideFunctions.bind(this);
        this.selectGoal = true;
        this.storageHandler = storageHandler;
    }

    /**
     * Updates the current move_base execution state and notifies registered operator listeners.
     *
     * Args:
     *     state: Action state returned by or synthesized for move_base.
     */
    public setMoveBaseState(state: ActionState): void {
        this.isMoveBaseActive =
            state.alert_type === "info" && state.state === "Navigation executing!";
        if (this.operatorCallback) this.operatorCallback(state);
    }

    /**
     * Cancels the current navigation goal and notifies remote robot and operator listeners.
     *
     * Args:
     *     onlyIfActive: When true, always sends a stop command to the robot but only
     *         emits the UI cancellation alert when navigation is actively executing.
     */
    public cancelGoal(onlyIfActive: boolean = false): void {
        const shouldNotifyUi = !onlyIfActive || this.isMoveBaseActive;
        this.isMoveBaseActive = false;
        if (shouldNotifyUi) {
            this.setMoveBaseState({
                state: "Navigation canceled!",
                alert_type: "error",
            });
        }
        FunctionProvider.remoteRobot?.stopMoveBase();
    }

    public provideFunctions(button: UnderMapButton) {
        switch (button) {
            case UnderMapButton.SelectGoal:
                return (toggle: boolean) => {
                    this.selectGoal = toggle;
                };
            case UnderMapButton.CancelGoal:
                return () => {
                    this.cancelGoal();
                };

            case UnderMapButton.DeleteGoal:
                return (idx: number) => {
                    let poses = this.storageHandler.getMapPoseNames();
                    this.storageHandler.deleteMapPose(poses[idx]);
                };
            case UnderMapButton.DeleteMapPose:
                return (poseName: string) => {
                    let poses = this.storageHandler.getMapPoseNames();
                    this.storageHandler.deleteMapPose(poseName);
                };

            case UnderMapButton.SaveGoal:
                return (name: string) => {
                    let pose = FunctionProvider.remoteRobot?.getMapPose();
                    if (!pose) throw "Cannot save undefined map pose!";
                    this.storageHandler.saveMapPose(name, pose, "MAP");
                };
            case UnderMapButton.LoadGoal:
                return (poseName: string) => {
                    let pose = this.storageHandler.getMapPose(poseName);
                    return pose;
                };
            case UnderMapButton.NavigateToPose:
                return (pose: Transform) => {
                    this.setMoveBaseState({
                        state: "Navigation executing!",
                        alert_type: "info",
                    });
                    let rosPose = {
                        position: {
                            x: pose.translation.x,
                            y: pose.translation.y,
                            z: 0,
                        },
                        orientation: {
                            x: pose.rotation.x,
                            y: pose.rotation.y,
                            z: pose.rotation.z,
                            w: pose.rotation.w,
                        },
                    } as ROSPose;
                    FunctionProvider.remoteRobot?.moveBase(rosPose);
                }
            case UnderMapButton.GetPose:
                return () => {
                    return FunctionProvider.remoteRobot?.getMapPose();
                };
            case UnderMapButton.GetSavedPoseNames:
                return () => {
                    return this.storageHandler.getMapPoseNames();
                };
            case UnderMapButton.GetSavedPoseTypes:
                return () => {
                    return this.storageHandler.getMapPoseTypes();
                };
            case UnderMapButton.GetSavedPoses:
                return () => {
                    return this.storageHandler.getMapPoses();
                };
            case UnderMapButton.RenamePose:
                return (poseNameOld: string, poseNameNew: string) => {
                    return this.storageHandler.renamePose(poseNameOld, poseNameNew);
                };
            default:
                throw Error(
                    `Cannot get function for unknown UnderMapButton ${button}`,
                );
        }
    }

    /**
     * Sets the local pointer to the operator's callback function, to be called
     * whenever the move base state changes.
     *
     * @param callback operator's callback function to update aruco navigation state
     */
    public setOperatorCallback(callback: (state: ActionState) => void) {
        this.operatorCallback = callback;
    }

    /**
     * Registers a callback function to be invoked when a map pose is set.
     *
     * @param callback - A function that receives a `ROSLIB.Vector3` object representing the pose on the map.
     */
    public setMapPoseCallback(callback: (pose: Vector3) => void) {
        this.mapPoseCallback = callback;
    }
}
