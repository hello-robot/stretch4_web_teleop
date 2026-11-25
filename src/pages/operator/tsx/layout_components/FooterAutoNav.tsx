import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import DeleteIcon from '@mui/icons-material/Delete';
import ModeEditIcon from '@mui/icons-material/ModeEdit';
import SearchIcon from '@mui/icons-material/Search';
import "operator/css/FooterAutoNav.css";
import React, { Dispatch, SetStateAction, useCallback, useEffect, useState } from 'react';
import { Transform } from 'roslib';
import {
    ROSPoint,
} from 'shared/util';
import InputFluid from '../basic_components/InputFluid';
import ModalMobile from '../basic_components/ModalMobile';
import MagneticWrapper from '../static_components/MagneticWrapper';
import ScrollableList from '../static_components/ScrollableList';
import { AutoNavFunctions } from "./AutoNav";
import { FooterCenterSlot } from "./FooterCenterSlot";

import AddLocationIcon from '../../icons/AddLocationIcon.svg';
import LocationsMenuIcon from '../../icons/LocationsMenuIcon.svg';
import { LocalStorageHandler } from '../storage_handler/LocalStorageHandler';
import { goalToTransform } from '../utils/goalPose';

/** Result from imperative AutoNav start/cancel (voice + UI share this path). */
export type AutoNavNavControlResult = {
    ok: boolean;
    detail: string;
};

/** Imperative AutoNav controls registered for voice (and similar callers). */
export type AutoNavNavControls = {
    start: () => AutoNavNavControlResult;
    cancel: () => AutoNavNavControlResult;
    loadLocation: (poseName: string) => AutoNavNavControlResult;
    getSavedPoseNames: () => string[];
    saveSelectedGoal: (label: string) => AutoNavNavControlResult;
};

const SAVED_LOCATION_ALREADY_SELECTED =
    "A saved location is already selected.";
const MAP_POSE_UNAVAILABLE =
    "Cannot save location — map pose unavailable.";

interface FooterAutoNavProps {
    handleSelectGoal: (selectGoal: boolean) => void;
    functs: AutoNavFunctions;
    isModalAddLocationVisible: boolean;
    isModalAddLocationVisibleSet: Dispatch<SetStateAction<boolean>>;
    isModalLocationsMenuVisible: boolean;
    isModalLocationsMenuVisibleSet: Dispatch<SetStateAction<boolean>>;
    isCurrentlyMoving: boolean;
    isCurrentlyMovingSet: Dispatch<SetStateAction<boolean>>;
    isSelectingGoal: boolean;
    isSelectingGoalSet: Dispatch<SetStateAction<boolean>>;
    selectedLocationMenuItem?: string;
    selectedLocationMenuItemSet: Dispatch<SetStateAction<string | undefined>>;
    goalPosition: ROSPoint | undefined; // Assuming goalPosition is a Vector3
    goalYaw: number | undefined;
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
    swipeableViewsIdxSet?: Dispatch<SetStateAction<number>>;
    sceneSelected?: string;
    onSceneSelectedChange?: Dispatch<SetStateAction<string>>;
    onRegisterAutoNavNavControls?: (controls: AutoNavNavControls | null) => void;
    /** Robot-pose mode replaces the center Start control with Cancel / Localize. */
    isSettingRobotPose?: boolean;
    onConfirmRobotPose?: () => void;
    onCancelRobotPose?: () => void;
}

interface ModalAddLocationProps {
    poses: string[];
    posesSet: Dispatch<SetStateAction<string[]>>;
    isModalAddLocationVisible: boolean;
    isModalAddLocationVisibleSet: Dispatch<SetStateAction<boolean>>;
    getPosesLatest: () => void;
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
    saveSelectedGoal: (label: string) => AutoNavNavControlResult;
    /** True when the save is a tapped destination, not the robot pose. */
    savingTappedDestination: boolean;
}

interface ModalLocationsMenuProps {
    poses: string[];
    posesSet: Dispatch<SetStateAction<string[]>>;
    selectedLocationMenuItemSet: Dispatch<SetStateAction<string | undefined>>;
    isModalLocationsMenuVisible: boolean;
    isModalLocationsMenuVisibleSet: Dispatch<SetStateAction<boolean>>;
    functs: AutoNavFunctions;
    getPosesLatest: () => void;
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
}

/**
 * ModalAddLocation component allows users to add a new location
 * by entering a name for the location.
 *
 * @param poses - Current list of saved poses.
 * @param posesSet - Function to update the list of saved poses.
 * @param isModalAddLocationVisible - State to control visibility of the modal.
 * @param isModalAddLocationVisibleSet - Function to set visibility of the modal.
 * @param getPosesLatest - Function to fetch the latest poses.
 * @param addToast - Function to display toast notifications.
 * @param saveSelectedGoal - Saves the tapped destination, or the robot pose when none is tapped.
 * @param savingTappedDestination - True when the save is a tapped destination.
 */

const ModalAddLocation: React.FC<ModalAddLocationProps> = ({
    poses,
    posesSet,
    isModalAddLocationVisibleSet,
    isModalAddLocationVisible,
    getPosesLatest,
    addToast,
    saveSelectedGoal,
    savingTappedDestination,
}) => {

    const [locationName, locationNameSet] = React.useState<string>("");
    const closeModal = useCallback(() => isModalAddLocationVisibleSet(false), []);
    const refInput = React.useRef<HTMLInputElement>(null);;

    // Update poses in localStorage, and
    // update local state, "poses"
    function handleAccept(): void {
        if (locationName.length > 0) {
            const result = saveSelectedGoal(locationName);
            if (result.ok) {
                const name = locationName.trim();
                if (!poses.includes(name)) {
                    posesSet((prevPoses) => [...prevPoses, name]);
                }
                addToast('info', result.detail);
                getPosesLatest();
            } else {
                addToast('error', result.detail);
            }
        }
        locationNameSet("");
        isModalAddLocationVisibleSet(false);
    }

    // Automatically focus the input field
    // when the modal is opened
    useEffect(() => {
        // Timeout is a workaround to ensure
        // modal is fully rendered
        //
        // Note: iOS forbids scripted focus() on
        //       <input> elements, so focus() won't
        //       work no matter what.
        const timer = setTimeout(() => {
            if (isModalAddLocationVisible && refInput.current) {
                refInput.current?.focus();
            }
        }, 1);
        // Cleanup the timer on unmount
        return () => clearTimeout(timer);
    }, [isModalAddLocationVisible]);

    const Footer = () => {
        return (
            <div className="footer-modal-add-location">
                <MagneticWrapper>
                    <button
                        disabled={locationName.length === 0}
                        className="btn btn-primary"
                        onClick={handleAccept}
                        aria-label="Add location"
                        aria-disabled={locationName.length === 0}
                    >
                        Save
                    </button>
                </MagneticWrapper>
                <MagneticWrapper>
                    <button
                        className="btn btn-tertiary"
                        onClick={closeModal}
                        aria-label="Close modal"
                    >
                        Close
                    </button>
                </MagneticWrapper>
            </div>
        )
    }

    return (
        <ModalMobile
            isOpen={isModalAddLocationVisible}
            onClose={() => isModalAddLocationVisibleSet(false)}
            title={savingTappedDestination ? "Save Selected Location" : "Save Stretch's Location"}
            subtitle="AUTONAV"
            modalClassName={
                savingTappedDestination ? "modal-add-location-destination" : ""
            }
            footer={<Footer />}
        >
            <input
                ref={refInput}
                type="text"
                id="new-pose-name"
                name="new-option-name"
                className="input"
                value={locationName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => locationNameSet(e.target.value)}
                placeholder="Use a helpful name for this location"
                autoComplete="off"
            />
        </ModalMobile>
    );
};

/**
 * LocationsMenuListItem component represents a single item in the Locations Menu.
 * It allows users to edit or delete a saved location.
 *
 * @param pose - The name of the location.
 * @param poses - Current list of saved poses.
 * @param posesSet - Function to update the list of saved poses.
 * @param functs - Functions for handling auto navigation.
 * @param getPosesLatest - Function to fetch the latest poses.
 * @param addToast - Function to display toast notifications.
 */

const LocationsMenuListItem: React.FC<{
    idx: number;
    pose: string;
    poses: string[];
    posesSet: Dispatch<SetStateAction<string[]>>;
    selectedLocationMenuItemSet: Dispatch<SetStateAction<string | undefined>>;
    functs: AutoNavFunctions;
    getPosesLatest: () => void;
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
    isModalLocationsMenuVisible: boolean;
    isModalLocationsMenuVisibleSet: Dispatch<SetStateAction<boolean>>;
}> = ({
    idx,
    pose,
    poses,
    posesSet,
    selectedLocationMenuItemSet,
    functs,
    getPosesLatest,
    addToast,
    isModalLocationsMenuVisible,
    isModalLocationsMenuVisibleSet
}) => {

        const [poseNew, poseNewSet] = useState<string>("");
        const [isEditing, isEditingSet] = useState<boolean>(false);
        const [isSelected, isSelectedSet] = useState<boolean>(false);
        const refInput = React.useRef<HTMLInputElement>(null);

        // Manage focus/blur for <InputFluid>
        useEffect(() => {
            if (isEditing && refInput.current) {
                refInput.current.focus();
            } else if (!isEditing) {
                refInput.current.blur();
            }
        }, [isEditing]);

        // Reset to initial state
        // after closing modal
        useEffect(() => {
            if (!isModalLocationsMenuVisible) {
                poseNewSet("");
                isEditingSet(false);
                isSelectedSet(false);
            }
        }, [isModalLocationsMenuVisible]);

        const activateEditMode = (e: React.PointerEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            e.preventDefault();
            poseNewSet(pose);
            isEditingSet(true);
        };

        const handleSave = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            e.preventDefault();
            // Update "pose" name if not already taken
            if (poseNew.length && !poses.includes(poseNew)) {
                functs.RenamePose(pose, poseNew);
                addToast('info', `Location "${pose}" renamed to "${poseNew}"`);
            }
            isEditingSet(false);
            getPosesLatest();
        }, [poseNew, poses, pose]);

        const handleDelete = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            e.preventDefault();
            functs.DeleteMapPose(pose);
            addToast('info', `Location "${pose}" deleted`);
            getPosesLatest();
        }, [functs, pose, addToast, getPosesLatest]);

        const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
            poseNewSet(e.target.value);
        }, []);

        // Handle when item
        // is selected
        const handleSelect = (poseName: string) => {
            isSelectedSet(true)
            addToast('info', `Selected "${poseName}"`);
            setTimeout(() => {
                selectedLocationMenuItemSet(poseName)
                isModalLocationsMenuVisibleSet(false);
            }, 1000);
        }

        // These are ARIA props that's only passed
        // when the item is not being edited.
        const ARIAProps = {
            onClick: (e) => {
                e.stopPropagation();
                e.preventDefault();
                handleSelect(refInput.current.value);
            },
            tabIndex: 0,
            role: "button",
            "aria-label": `Select ${pose}`,
        }

        return (
            <li
                className={`locations-menu-list-item ${isSelected ? 'selected' : ''}`}
            >
                <div
                    className="locations-menu-list-item-left-column"
                    {...(!isEditing && ARIAProps)}
                >
                    <InputFluid
                        refInput={refInput}
                        value={poseNew || pose}
                        onChange={onChange}
                        disabled={!isEditing}
                        onBlur={handleSave}
                        autoComplete="off"
                        classNameInput="locations-menu-list-item-input"
                    />
                </div>
                <div className="locations-menu-list-item-right-column">
                    {!isEditing
                        ? (
                            <>
                                <button
                                    className={`locations-menu-list-item-edit-button ${isEditing ? 'editing' : ''}`}
                                    aria-label={`Edit ${pose}`}
                                    onClick={activateEditMode}
                                >
                                    <ModeEditIcon role="img" aria-hidden="true" fontSize="small" />
                                </button>

                                <button
                                    onClick={handleDelete}
                                    className="locations-menu-list-item-delete-button"
                                    aria-label={`Delete ${pose}`}
                                >
                                    <DeleteIcon role="img" aria-hidden="true" fontSize="small" />
                                </button>
                            </>
                        )
                        : (
                            <button
                                onClick={handleSave}
                                className="btn btn-primary btn-sm"
                                disabled={!poseNew || poseNew.trim() === pose}
                                aria-label={`Save as ${poseNew}`}
                            >
                                Save
                            </button>
                        )}
                </div>
            </li >
        );
    }

/**
 * ModalLocationsMenu component displays a list of saved locations
 * for auto navigation. Users can select a location to navigate to.
 *
 * @param poses - List of saved poses for navigation goals.
 * @param posesSet - Function to update the list of saved poses.
 * @param functs - Functions for handling auto navigation.
 * @param isModalLocationsMenuVisible - State to control visibility of the modal.
 * @param isModalLocationsMenuVisibleSet - Function to set visibility of the modal.
 * @param getPosesLatest - Function to fetch the latest poses.
 * @param addToast - Function to display toast notifications.
 */

const ModalLocationsMenu: React.FC<ModalLocationsMenuProps> = ({
    poses,
    posesSet,
    selectedLocationMenuItemSet,
    functs,
    isModalLocationsMenuVisible,
    isModalLocationsMenuVisibleSet,
    getPosesLatest,
    addToast,
}) => {

    const [searchActive, setSearchActive] = useState<boolean>(false);
    const [searchTerm, setSearchTerm] = useState<string>("");
    const closeModal = useCallback(() => isModalLocationsMenuVisibleSet(false), []);

    const items = poses
        // Filter poses based on "searchTerm"...
        .filter((pose) => {
            return pose.toLowerCase().includes(searchTerm.toLowerCase());
        })
        // Reverse order to show
        // latest poses first...
        .reverse()
        // ...Map
        .map((pose, idx) => (
            <LocationsMenuListItem
                idx={idx}
                key={pose}
                pose={pose}
                poses={poses}
                posesSet={posesSet}
                selectedLocationMenuItemSet={selectedLocationMenuItemSet}
                functs={functs}
                getPosesLatest={getPosesLatest}
                addToast={addToast}
                isModalLocationsMenuVisible={isModalLocationsMenuVisible}
                isModalLocationsMenuVisibleSet={isModalLocationsMenuVisibleSet}
            />
        ))

    // Reset search when activate/deactivated
    useEffect(() => {
        setSearchTerm("");
    }, [searchActive]);

    // Reset search when modal is closed
    useEffect(() => {
        if (!isModalLocationsMenuVisible) {
            setSearchActive(false);
            setSearchTerm("");
        }
    }, [isModalLocationsMenuVisible]);

    // Reload from storage whenever the menu opens (e.g. after a voice save).
    useEffect(() => {
        if (isModalLocationsMenuVisible) {
            getPosesLatest();
        }
    }, [isModalLocationsMenuVisible, getPosesLatest]);

    const Footer = () => (
        <MagneticWrapper>
            <button
                className="btn btn-tertiary"
                onClick={closeModal}
            >
                Close
            </button>
        </MagneticWrapper>
    );

    const HeaderControls = () => (
        <div className={`locations-menu-search-controls ${searchActive ? 'active' : ''}`}>
            {!searchActive
                ? <button
                    className="locations-menu-search-btn"
                    onClick={() => setSearchActive(true)}
                    aria-label="Search locations"
                >
                    <SearchIcon />
                </button>
                : (
                    <div className="locations-menu-search-input-wrapper">
                        <button
                            className={`locations-menu-search-close-btn ${searchTerm.trim().length ? 'active' : ''}`}
                            onClick={() => setSearchActive(false)}
                            aria-label="Close search"
                        >
                            <ChevronLeftIcon />
                        </button>
                        <input
                            type="text"
                            className="locations-menu-search-input"
                            placeholder="Type to filter..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            autoFocus
                        />
                    </div>
                )
            }
        </div>
    );

    return (
        <ModalMobile
            isOpen={isModalLocationsMenuVisible}
            onClose={closeModal}
            title="Saved Locations"
            subtitle="AUTONAV"
            HeaderControls={<HeaderControls />}
            footer={<Footer />}
        >
            <ScrollableList
                items={items}
                height={250}
                className="locations-menu-list"
            />
        </ModalMobile>
    );
};

/**
 * FooterAutoNav component provides a footer for auto navigation controls.
 * It includes buttons for starting navigation, adding locations,
 * and accessing the locations menu.
 *
 * @param handleSelectGoal - Function to handle goal selection.
 * @param functs - Functions for handling auto navigation.
 * @param isModalAddLocationVisible - State to control visibility of the Add Location modal.
 * @param isModalAddLocationVisibleSet - Function to set visibility of the Add Location modal
 * @param isModalLocationsMenuVisible - State to control visibility of the Locations Menu modal.
 * @param isModalLocationsMenuVisibleSet - Function to set visibility of the Locations Menu modal
 * @param isCurrentlyMoving - State indicating if the robot is currently moving.
 * @param isCurrentlyMovingSet - Function to set the current moving state.
 * @param isSelectingGoal - State indicating if a goal is currently being selected.
 * @param isSelectingGoalSet - Function to set the goal selection state.
 * @param selectedLocationMenuItem - The name of the selected location menu item.
 * @param swipeableViewsIdxSet - Function to set the index of the swipeable views.
 * @param goalPosition - Current goal position for navigation.
 * @param goalYaw - Heading of the tapped destination, in map-frame radians.
 * @param addToast - Function to display toast notifications.
 */

const FooterAutoNav: React.FC<FooterAutoNavProps> = ({
    handleSelectGoal,
    functs,
    isModalAddLocationVisible,
    isModalAddLocationVisibleSet,
    isModalLocationsMenuVisible,
    isModalLocationsMenuVisibleSet,
    isCurrentlyMoving,
    isCurrentlyMovingSet,
    isSelectingGoal,
    isSelectingGoalSet,
    selectedLocationMenuItem,
    selectedLocationMenuItemSet,
    swipeableViewsIdxSet,
    goalPosition,
    goalYaw,
    addToast,
    sceneSelected,
    onSceneSelectedChange,
    onRegisterAutoNavNavControls,
    isSettingRobotPose = false,
    onConfirmRobotPose,
    onCancelRobotPose,
}) => {

    React.useEffect(() => {
        if (selectedLocationMenuItem) {
            let pose: Transform = functs.LoadGoal(selectedLocationMenuItem)!;
            functs.DisplayGoalMarker(pose.translation, pose.rotation);
            functs.ClearTappedGoal();
        }
    }, [selectedLocationMenuItem]);

    // Shared by Start button and voice control_autonav.
    const startAutoNav = useCallback((): AutoNavNavControlResult => {
        if (isCurrentlyMoving) {
            return {
                ok: false,
                detail: "AutoNav is already navigating.",
            };
        }
        if (
            selectedLocationMenuItem === undefined &&
            !goalPosition
        ) {
            return {
                ok: false,
                detail: "Load a pose or select a goal before starting AutoNav.",
            };
        }
        // ...when selecting from Locations Menu
        if (selectedLocationMenuItem !== undefined) {
            let pose: Transform = functs.LoadGoal(selectedLocationMenuItem)!;
            functs.NavigateToPose(pose);
            functs.ClearTappedGoal();
            isCurrentlyMovingSet(true);
            isSelectingGoalSet(false);
            selectedLocationMenuItemSet(undefined);
            // Completion clears via terminal moveBaseState in AutoNav.
            return { ok: true, detail: "Started AutoNav." };
        }
        // When selecting manually on map...
        if (isSelectingGoal) {
            functs.Play();
            isCurrentlyMovingSet(true);
            isSelectingGoalSet(false);
            // Completion clears via terminal moveBaseState in AutoNav.
            return { ok: true, detail: "Started AutoNav." };
        }
        return {
            ok: false,
            detail: "Load a pose or select a goal before starting AutoNav.",
        };
    }, [
        functs,
        isCurrentlyMoving,
        isSelectingGoalSet,
        isSelectingGoal,
        selectedLocationMenuItem,
        selectedLocationMenuItemSet,
        goalPosition,
        isCurrentlyMovingSet,
    ]);

    const cancelAutoNav = useCallback((): AutoNavNavControlResult => {
        functs.CancelGoal();
        functs.RemoveGoalMarker();
        isCurrentlyMovingSet(false);
        isSelectingGoalSet(true);
        return { ok: true, detail: "Cancelled AutoNav." };
    }, [
        functs,
        isCurrentlyMovingSet,
        isSelectingGoalSet,
    ]);

    // List of saved pose names for navigation goals
    const [poses, posesSet] = useState<string[]>(
        functs.GetSavedPoseNames(),
    );

    // Function to fetch the latest
    // pose names from localStorage
    // and update the local state, "poses".
    const getPosesLatest = useCallback(() => {
        // Fetch the latest pose names from the function provider...
        const poses = functs.GetSavedPoseNames();
        // Update local state with latest poses...
        posesSet(poses);
    }, [functs]);

    const getSavedPoseNames = useCallback(
        () => functs.GetSavedPoseNames(),
        [functs],
    );

    const loadLocation = useCallback(
        (poseName: string): AutoNavNavControlResult => {
            const names = functs.GetSavedPoseNames();
            if (!names.includes(poseName)) {
                return {
                    ok: false,
                    detail: `Unknown location: "${poseName}".`,
                };
            }
            selectedLocationMenuItemSet(poseName);
            isModalLocationsMenuVisibleSet(false);
            return {
                ok: true,
                detail: `Selected "${poseName}"`,
            };
        },
        [
            functs,
            selectedLocationMenuItemSet,
            isModalLocationsMenuVisibleSet,
        ],
    );

    const saveSelectedGoal = useCallback(
        (label: string): AutoNavNavControlResult => {
            const name = label.trim();
            if (!name) {
                return { ok: false, detail: "Missing location label." };
            }
            if (selectedLocationMenuItem !== undefined) {
                return {
                    ok: false,
                    detail: SAVED_LOCATION_ALREADY_SELECTED,
                };
            }
            try {
                const pose = goalPosition
                    ? goalToTransform(goalPosition, goalYaw ?? 0)
                    : functs.GetPose();
                if (!pose?.translation || !pose?.rotation) {
                    return {
                        ok: false,
                        detail: MAP_POSE_UNAVAILABLE,
                    };
                }
                functs.SaveGoal(name, pose);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    ok: false,
                    detail: `Failed to save location: ${msg}`,
                };
            }
            return { ok: true, detail: `Location "${name}" added.` };
        },
        [functs, goalPosition, goalYaw, selectedLocationMenuItem],
    );

    const canSaveLocation = selectedLocationMenuItem === undefined;
    const savingTappedDestination =
        goalPosition !== undefined && canSaveLocation;
    const locationActionsDisabled = isSettingRobotPose;

    useEffect(() => {
        if (!isSettingRobotPose) return;
        isModalLocationsMenuVisibleSet(false);
        isModalAddLocationVisibleSet(false);
    }, [
        isSettingRobotPose,
        isModalLocationsMenuVisibleSet,
        isModalAddLocationVisibleSet,
    ]);

    useEffect(() => {
        if (!onRegisterAutoNavNavControls) {
            return;
        }
        onRegisterAutoNavNavControls({
            start: startAutoNav,
            cancel: cancelAutoNav,
            loadLocation,
            getSavedPoseNames,
            saveSelectedGoal,
        });
        return () => onRegisterAutoNavNavControls(null);
    }, [
        onRegisterAutoNavNavControls,
        startAutoNav,
        cancelAutoNav,
        loadLocation,
        getSavedPoseNames,
        saveSelectedGoal,
    ]);

    // Voice (and other non-UI) saves write storage without updating React state.
    useEffect(() => {
        const onMapPosesChanged = () => getPosesLatest();
        window.addEventListener(
            LocalStorageHandler.MAP_POSES_CHANGED_EVENT,
            onMapPosesChanged,
        );
        return () => {
            window.removeEventListener(
                LocalStorageHandler.MAP_POSES_CHANGED_EVENT,
                onMapPosesChanged,
            );
        };
    }, [getPosesLatest]);

    return (
        <div className="footer-auto-nav">
            <div className="footer-row">
                {/* <LocationsMenu> */}
                <div className="locations-menu-wrapper">
                    <ModalLocationsMenu
                        poses={poses}
                        posesSet={posesSet}
                        selectedLocationMenuItemSet={selectedLocationMenuItemSet}
                        functs={functs}
                        isModalLocationsMenuVisible={isModalLocationsMenuVisible}
                        isModalLocationsMenuVisibleSet={isModalLocationsMenuVisibleSet}
                        getPosesLatest={getPosesLatest}
                        addToast={addToast}
                    />
                    <MagneticWrapper>
                        <button
                            type="button"
                            onClick={() => {
                                isModalLocationsMenuVisibleSet(true);
                            }}
                            className="locations-menu"
                            aria-label="Open locations menu"
                            disabled={locationActionsDisabled}
                            aria-disabled={locationActionsDisabled}
                        >
                            <img src={LocationsMenuIcon} className="locations-menu-icon" alt="" aria-hidden="true" />
                        </button>
                    </MagneticWrapper>
                </div>
                {/* </LocationsMenu> */}
                <FooterCenterSlot
                    mode={
                        isSettingRobotPose
                            ? "pose"
                            : isCurrentlyMoving
                                ? "stop"
                                : "start"
                    }
                    goalReady={Boolean(goalPosition || selectedLocationMenuItem)}
                    localizeReady={Boolean(goalPosition)}
                    onStart={() => {
                        startAutoNav();
                    }}
                    onStop={() => {
                        cancelAutoNav();
                    }}
                    onCancelPose={() => onCancelRobotPose?.()}
                    onConfirmPose={() => onConfirmRobotPose?.()}
                />
                {/* </AutoNavMainButton> */}
                {/* <AddLocationButton> */}
                <div className="add-location-wrapper">
                    <ModalAddLocation
                        poses={poses}
                        posesSet={posesSet}
                        isModalAddLocationVisible={isModalAddLocationVisible}
                        isModalAddLocationVisibleSet={isModalAddLocationVisibleSet}
                        getPosesLatest={getPosesLatest}
                        addToast={addToast}
                        saveSelectedGoal={saveSelectedGoal}
                        savingTappedDestination={savingTappedDestination}
                    />
                    <MagneticWrapper>
                        <button
                            type="button"
                            onClick={() => {
                                isModalAddLocationVisibleSet(true);
                            }}
                            className="add-location"
                            aria-label="Add location"
                            disabled={locationActionsDisabled || !canSaveLocation}
                            aria-disabled={locationActionsDisabled || !canSaveLocation}
                        >
                            <img src={AddLocationIcon} className="add-location-icon" alt="" aria-hidden="true" />
                        </button>
                    </MagneticWrapper>
                </div>
                {/* </AddLocationButton> */}
            </div>
        </div>
    );
};

export default FooterAutoNav;
