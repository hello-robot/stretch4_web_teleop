import { mapFunctionProvider, underMapFunctionProvider } from 'operator/tsx/index';
import React, { Dispatch, SetStateAction, useEffect, useState } from 'react';
import { Quaternion, Transform, Vector3 } from 'roslib';
import {
    ActionState,
    ROSOccupancyGrid,
    ROSPoint,
    ROSPose,
} from 'shared/util';
import '../../css/AutoNav.css';
import { UnderMapButton } from '../function_providers/UnderMapFunctionProvider';
import { Canvas } from "../static_components/Canvas";
import { OccupancyGrid } from '../static_components/OccupancyGrid';
import { SharedState } from './CustomizableComponent';
import FooterAutoNav, { type AutoNavNavControls } from './FooterAutoNav';
import { Map } from './Map';
import type { AddToastFn } from './Toasts';

interface AutoNavProps {
    sharedState: SharedState;
    swipeableViewsIdx: number;
    swipeableViewsIdxSet: Dispatch<SetStateAction<number>>;
    sceneSelected: string;
    onSceneSelectedChange: Dispatch<SetStateAction<string>>;
    addToast: AddToastFn;
    isModalLocationsMenuVisible: boolean;
    isModalLocationsMenuVisibleSet: Dispatch<SetStateAction<boolean>>;
    onRegisterAutoNavNavControls?: (controls: AutoNavNavControls | null) => void;
    /** Terminal move-base alerts clear AutoNav Start/Stop UI. */
    moveBaseState?: ActionState;
}

export enum MapFunction {
    GetMap,
    GetPose,
    MoveBase,
    GoalReached,
}

/**
 * TODO: AutoNavFunctions and MapFunctions should be merged
 * into a single interface.
 */

export interface AutoNavFunctions {
    SelectGoal: (toggle: boolean) => void;
    CancelGoal: () => void;
    DeleteGoal: (goalId: number) => void;
    DeleteMapPose: (poseName: string) => void;
    SaveGoal: (locationName: string) => void;
    LoadGoal: (poseName: string) => Transform;
    NavigateToPose: (pose: Transform) => void;
    GetPose: () => Transform;
    GetSavedPoseNames: () => string[];
    GetSavedPoseTypes: () => string[];
    GetSavedPoses: () => Transform[];
    DisplayPoseMarkers: (
        toggle: boolean,
        poses: Transform[],
        poseNames: string[],
        poseTypes: string[],
    ) => void;
    DisplayGoalMarker: (pose: Vector3, rotation?: Quaternion) => void;
    Play: () => void;
    RemoveGoalMarker: () => void;
    GoalReached: () => Promise<boolean>;
    RenamePose: (poseNameOld: string, poseNameNew: string) => void;
}

export interface MapFunctions {
    GetMap: ROSOccupancyGrid;
    GetPose: () => Transform;
    MoveBase: (pose: ROSPose) => void;
    GoalReached: () => boolean;
    SelectGoal: () => boolean;
    SetSelectGoal: (selectGoal: boolean) => void;
}

/**
 * AutoNav component for handling autonomous navigation features.
 * It provides a map interface, goal selection, and navigation controls.
 *
 * @param sharedState - Shared state for the application
 * @param swipeableViewsIdx - Current index of the swipeable views
 * @param swipeableViewsIdxSet - Function to set the swipeable views index
 */

const AutoNav: React.FC<AutoNavProps> = ({
    sharedState,
    swipeableViewsIdx,
    swipeableViewsIdxSet,
    sceneSelected,
    onSceneSelectedChange,
    addToast,
    isModalLocationsMenuVisible,
    isModalLocationsMenuVisibleSet,
    onRegisterAutoNavNavControls,
    moveBaseState,
}) => {

    // Index of the selected .locations-menu-list-item
    const [selectedLocationMenuItem, selectedLocationMenuItemSet] = useState<string | undefined>();

    // Manage goal position
    const [goalPosition, goalPositionSet] = useState<ROSPoint | undefined>(undefined);

    // OccupancyGrid instance for map and marker operations
    const [occupancyGrid, occupancyGridSet] = useState<OccupancyGrid>();

    // Subscribe to goal position updates from the OccupancyGrid
    useEffect(() => {
        const callback = (pos: ROSPoint | undefined) => {
            goalPositionSet(pos);
        };
        const unsubscribeOnUnmount = occupancyGrid?.goalPositionSubscribe(callback);
        return () => {
            // Return callback to unsubscribe
            // when <AutoNav> component unmounts
            if (unsubscribeOnUnmount) unsubscribeOnUnmount();
        };
    }, [occupancyGrid]);

    /**
     * All navigation-related functions, provided by underMapFunctionProvider.
     * Many of these are ROS actions or service calls.
     * Some functions require occupancyGrid to be set.
     */
    const functs: AutoNavFunctions = {
        SelectGoal: underMapFunctionProvider.provideFunctions(
            UnderMapButton.SelectGoal,
        ) as (toggle: boolean) => void,
        CancelGoal: underMapFunctionProvider.provideFunctions(
            UnderMapButton.CancelGoal,
        ) as () => void,
        DeleteGoal: underMapFunctionProvider.provideFunctions(
            UnderMapButton.DeleteGoal,
        ) as (goalId: number) => void,
        DeleteMapPose: underMapFunctionProvider.provideFunctions(
            UnderMapButton.DeleteMapPose,
        ) as (poseName: string) => void,
        SaveGoal: underMapFunctionProvider.provideFunctions(
            UnderMapButton.SaveGoal,
        ) as (locationName: string) => void,
        LoadGoal: underMapFunctionProvider.provideFunctions(
            UnderMapButton.LoadGoal,
        ) as (poseName: string) => Transform,
        NavigateToPose: underMapFunctionProvider.provideFunctions(
            UnderMapButton.NavigateToPose,
        ) as (pose: Transform) => void,
        GetPose: underMapFunctionProvider.provideFunctions(
            UnderMapButton.GetPose,
        ) as () => Transform,
        GetSavedPoseNames: underMapFunctionProvider.provideFunctions(
            UnderMapButton.GetSavedPoseNames,
        ) as () => string[],
        GetSavedPoseTypes: underMapFunctionProvider.provideFunctions(
            UnderMapButton.GetSavedPoseTypes,
        ) as () => string[],
        GetSavedPoses: underMapFunctionProvider.provideFunctions(
            UnderMapButton.GetSavedPoses,
        ) as () => Transform[],

        /**
         * Display pose markers on the map. Requires occupancyGrid to be set.
         */
        DisplayPoseMarkers: (
            toggle: boolean,
            poses: Transform[],
            poseNames: string[],
            poseTypes: string[],
        ) => {
            return occupancyGrid!.displayPoseMarkers(
                toggle,
                poses,
                poseNames,
                poseTypes,
            );
        },
        /**
         * Display a goal marker on the map at the given pose.
         */
        DisplayGoalMarker: (pose: Vector3, rotation?: Quaternion) =>
            occupancyGrid!.createGoalMarker(pose.x, pose.y, true, rotation),

        /**
         * Play the current navigation sequence (if supported by occupancyGrid).
         */
        Play: () => occupancyGrid!.play(),
        RemoveGoalMarker: () => occupancyGrid!.removeGoalMarker(),
        GoalReached: underMapFunctionProvider.provideFunctions(
            UnderMapButton.GoalReached,
        ) as () => Promise<boolean>,
        RenamePose: underMapFunctionProvider.provideFunctions(
            UnderMapButton.RenamePose,
        ) as (poseNameOld: string, poseNameNew: string) => void,
    };

    /**
     * Callback to update the goal selection state and update mapFn.SelectGoal.
     */
    const handleSelectGoal = (isSelectingGoal: boolean) => {
        isSelectingGoalSet(isSelectingGoal);
        mapFn.SelectGoal = (): boolean => {
            return isSelectingGoal;
        };
    };

    /**
     * Map-related functions for interacting with the map and robot pose.
     * These are provided by mapFunctionProvider.
     */
    const mapFn: MapFunctions = {
        GetMap: mapFunctionProvider.provideFunctions(
            MapFunction.GetMap,
        ) as ROSOccupancyGrid,
        GetPose: mapFunctionProvider.provideFunctions(
            MapFunction.GetPose,
        ) as () => Transform,
        MoveBase: mapFunctionProvider.provideFunctions(
            MapFunction.MoveBase,
        ) as (pose: ROSPose) => void,
        GoalReached: mapFunctionProvider.provideFunctions(
            MapFunction.GoalReached,
        ) as () => boolean,
        /**
         * Returns whether a goal is currently being selected.
         */
        SelectGoal: (): boolean => {
            return isSelectingGoal;
        },
        /**
         * Sets the goal selection state.
         */
        SetSelectGoal: (isSelectingGoal: boolean) => {
            handleSelectGoal(isSelectingGoal);
        },
    };

    // Modal visibility state for adding a location
    const [isModalAddLocationVisible, isModalAddLocationVisibleSet] = useState<boolean>(false);
    // Whether to display all goal markers on the map
    const [displayGoals, displayGoalsSet] = useState<boolean>(false);
    // Navigation goal selection state (true if selecting a goal).
    const [isSelectingGoal, isSelectingGoalSet] = useState<boolean>(true);
    // Whether the robot is currently auto-navigating
    const [isCurrentlyMoving, isCurrentlyMovingSet] = useState<boolean>(false);

    // Drive Start/Stop from terminal Nav2 / cancel alerts (not GoalReached flag race).
    useEffect(() => {
        if (!moveBaseState) {
            return;
        }
        const alertType = moveBaseState.alert_type;
        if (
            alertType !== "success" &&
            alertType !== "warning" &&
            alertType !== "error"
        ) {
            return;
        }
        isCurrentlyMovingSet(false);
        isSelectingGoalSet(true);
        occupancyGrid?.removeGoalMarker();
        // Force a marker refresh in case the last amclPose was dropped in flight.
        try {
            occupancyGrid?.updateRobotMarker(functs.GetPose());
        } catch {
            // Pose may be unavailable before WebRTC map TF arrives.
        }
    }, [moveBaseState, occupancyGrid]);

    /**
     * On mount, create the canvas and OccupancyGrid for the map.
     * This sets up the map rendering and interaction logic.
     */
    useEffect(() => {
        let map = mapFn.GetMap;
        let width = map ? map.info.width : 60;
        let height = map ? map.info.height : 100;
        var canvas = new Canvas({
            divID: "map",
            className: "mapCanvas",
            width: width * 5, // Scale width to avoid blurriness when making map larger
            height: height * 5, // Scale height to avoid blurriness when making map larger
        });
        var occupancyGrid = new OccupancyGrid({
            functs: mapFn,
            rootObject: canvas.scene!,
        });
        canvas.scaleToDimensions(
            occupancyGrid.width,
            occupancyGrid.height,
        );
        // Stage scale is applied above; refresh so markers use the real scale.
        occupancyGrid.refreshMarkerScales();
        occupancyGridSet(occupancyGrid);
        return () => {
            occupancyGrid.dispose();
        };
    }, []);

    // Show friendly, helpful toast when
    // user dives into the AutoNav UX
    useEffect(() => {
        // Synthetic lag
        setTimeout(() => {
            if (swipeableViewsIdx === 1) {
                addToast('info', 'Click on the map to navigate');
            }
        }, 500)
    }, [swipeableViewsIdx])

    return (
        <div className='auto-nav'>
            <div className="map-wrapper">
                <Map />
            </div>
            <FooterAutoNav
                handleSelectGoal={handleSelectGoal}
                functs={functs}
                isModalAddLocationVisible={isModalAddLocationVisible}
                isModalAddLocationVisibleSet={isModalAddLocationVisibleSet}
                isModalLocationsMenuVisible={isModalLocationsMenuVisible}
                isModalLocationsMenuVisibleSet={isModalLocationsMenuVisibleSet}
                isCurrentlyMoving={isCurrentlyMoving}
                isCurrentlyMovingSet={isCurrentlyMovingSet}
                isSelectingGoal={isSelectingGoal}
                isSelectingGoalSet={isSelectingGoalSet}
                selectedLocationMenuItem={selectedLocationMenuItem}
                selectedLocationMenuItemSet={selectedLocationMenuItemSet}
                goalPosition={goalPosition}
                addToast={addToast}
                swipeableViewsIdxSet={swipeableViewsIdxSet}
                sceneSelected={sceneSelected}
                onSceneSelectedChange={onSceneSelectedChange}
                onRegisterAutoNavNavControls={onRegisterAutoNavNavControls}
            />
        </div>
    );
};

export default AutoNav;
