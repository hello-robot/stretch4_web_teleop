import React, { Dispatch, useRef, SetStateAction, useState, useCallback, useEffect } from 'react';
import ModalMobile from '../basic_components/ModalMobile';
import { AutoNavFunctions } from "./AutoNav";
import MagneticWrapper from '../static_components/MagneticWrapper';
import {
    ROSPoint,
} from 'shared/util';
import { Transform } from 'roslib';
import "operator/css/FooterAutoNav.css";
import { motion } from 'framer-motion';
import InputFluid from '../basic_components/InputFluid';
import SearchIcon from '@mui/icons-material/Search';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ScrollableList from '../static_components/ScrollableList';
import DeleteIcon from '@mui/icons-material/Delete';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import ModeEditIcon from '@mui/icons-material/ModeEdit';
import FooterGlobal from './FooterGlobal';
import { set } from 'firebase/database';

import StartNavIcon from '../../icons/StartNavIcon.svg';
import LocationsMenuIcon from '../../icons/LocationsMenuIcon.svg';
import AddLocationIcon from '../../icons/AddLocationIcon.svg';
import { LocalStorageHandler } from '../storage_handler/LocalStorageHandler';

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
};

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
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
    swipeableViewsIdxSet?: Dispatch<SetStateAction<number>>;
    sceneSelected?: string;
    onSceneSelectedChange?: Dispatch<SetStateAction<string>>;
    onRegisterAutoNavNavControls?: (controls: AutoNavNavControls | null) => void;
}

interface ModalAddLocationProps {
    functs: AutoNavFunctions;
    poses: string[];
    posesSet: Dispatch<SetStateAction<string[]>>;
    isModalAddLocationVisible: boolean;
    isModalAddLocationVisibleSet: Dispatch<SetStateAction<boolean>>;
    getPosesLatest: () => void;
    addToast: (type: "success" | "error" | "info", message: string, duration?: number) => void;
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
 * @param functs - Functions for handling auto navigation.
 * @param poses - Current list of saved poses.
 * @param posesSet - Function to update the list of saved poses.
 * @param isModalAddLocationVisible - State to control visibility of the modal.
 * @param isModalAddLocationVisibleSet - Function to set visibility of the modal.
 * @param getPosesLatest - Function to fetch the latest poses.
 * @param addToast - Function to display toast notifications.
 */

const ModalAddLocation: React.FC<ModalAddLocationProps> = ({
    functs,
    poses,
    posesSet,
    isModalAddLocationVisibleSet,
    isModalAddLocationVisible,
    getPosesLatest,
    addToast,
}) => {

    const [locationName, locationNameSet] = React.useState<string>("");
    const closeModal = useCallback(() => isModalAddLocationVisibleSet(false), []);
    const refInput = React.useRef<HTMLInputElement>(null);;

    // Update poses in localStorage, and
    // update local state, "poses"
    function handleAccept(): void {
        if (locationName.length > 0) {
            if (!poses.includes(locationName)) {
                posesSet((prevPoses) => [...prevPoses, locationName]);
            }
            functs.SaveGoal(locationName);
            addToast('info', `Location "${locationName}" added.`);
            getPosesLatest();
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
                        Add Location
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
            title="Add Location"
            subtitle="AUTONAV"
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
    addToast,
    sceneSelected,
    onSceneSelectedChange,
    onRegisterAutoNavNavControls,
}) => {

    React.useEffect(() => {
        if (selectedLocationMenuItem) {
            let pose: Transform = functs.LoadGoal(selectedLocationMenuItem)!;
            functs.DisplayGoalMarker(pose.translation, pose.rotation);
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
            // functs.DisplayGoalMarker(pose.translation);
            isCurrentlyMovingSet(true);
            isSelectingGoalSet(false);
            selectedLocationMenuItemSet(undefined);
            functs.GoalReached().then(() => {
                isCurrentlyMovingSet(false);
                isSelectingGoalSet(true);
            });
            return { ok: true, detail: "Started AutoNav." };
        }
        // When selecting manually on map...
        if (isSelectingGoal) {
            functs.Play();
            isCurrentlyMovingSet(true);
            isSelectingGoalSet(false);
            functs.GoalReached().then(() => {
                isCurrentlyMovingSet(false);
                isSelectingGoalSet(true);
            });
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
        if (!isCurrentlyMoving) {
            return {
                ok: false,
                detail: "AutoNav is not navigating.",
            };
        }
        functs.CancelGoal();
        isCurrentlyMovingSet(false);
        isSelectingGoalSet(true);
        return { ok: true, detail: "Cancelled AutoNav." };
    }, [
        functs,
        isCurrentlyMoving,
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

    useEffect(() => {
        if (!onRegisterAutoNavNavControls) {
            return;
        }
        onRegisterAutoNavNavControls({
            start: startAutoNav,
            cancel: cancelAutoNav,
            loadLocation,
            getSavedPoseNames,
        });
        return () => onRegisterAutoNavNavControls(null);
    }, [
        onRegisterAutoNavNavControls,
        startAutoNav,
        cancelAutoNav,
        loadLocation,
        getSavedPoseNames,
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
                    <button
                        type="button"
                        onClick={() => {
                            isModalLocationsMenuVisibleSet(true);
                        }}
                        className="locations-menu"
                        aria-label="Open locations menu"
                    >
                        <img src={LocationsMenuIcon} className="locations-menu-icon" alt="" aria-hidden="true" />
                    </button>
                </div>
                {/* </LocationsMenu> */}
                {/* <StartNavButton> */}
                {!isCurrentlyMoving
                    ? (
                        <motion.button
                            onClick={() => {
                                startAutoNav();
                            }}
                            disabled={!goalPosition && !selectedLocationMenuItem}
                            className="auto-nav-button"
                            initial={false}
                            animate={
                                goalPosition || selectedLocationMenuItem
                                    ? { width: 100 }
                                    : { width: 70 }
                            }
                            transition={{
                                type: 'spring',
                                stiffness: 300,
                                damping: 20,
                                mass: 0.7,
                                bounce: 0.6,
                            }}
                            style={{ overflow: 'hidden', display: 'inline-flex', alignItems: 'center' }}
                        >
                            <span>Start</span>
                            <motion.img
                                src={StartNavIcon}
                                className="auto-nav-button-icon"
                                initial={{ x: -40, opacity: 0, filter: 'brightness(1)' }}
                                animate={goalPosition || selectedLocationMenuItem
                                    ? { x: 0, opacity: 1, filter: ['brightness(1)', 'brightness(1.7)', 'brightness(1)'] }
                                    : { x: 20, opacity: 0, filter: 'brightness(1)' }
                                }
                                transition={goalPosition || selectedLocationMenuItem
                                    ? {
                                        type: 'spring',
                                        stiffness: 400,
                                        damping: 12,
                                        mass: 0.6,
                                        bounce: 0.7,
                                        filter: {
                                            duration: 2,
                                            repeat: Infinity,
                                            repeatType: 'loop',
                                            ease: 'easeInOut',
                                        },
                                    }
                                    : {
                                        type: 'spring',
                                        stiffness: 400,
                                        damping: 12,
                                        mass: 0.6,
                                        bounce: 0.7,
                                    }
                                }
                                style={{ display: 'inline-block', marginLeft: 8 }}
                            />
                        </motion.button>
                    )
                    : (<button
                        className="cancel-auto-nav-button"
                        onClick={() => {
                            cancelAutoNav();
                        }}
                    >
                        <span>Stop</span>
                        <StopCircleIcon className="cancel-auto-nav-icon" />
                    </button>)}
                {/* </AutoNavMainButton> */}
                {/* <AddLocationButton> */}
                <div className="add-location-wrapper">
                    <ModalAddLocation
                        functs={functs}
                        poses={poses}
                        posesSet={posesSet}
                        isModalAddLocationVisible={isModalAddLocationVisible}
                        isModalAddLocationVisibleSet={isModalAddLocationVisibleSet}
                        getPosesLatest={getPosesLatest}
                        addToast={addToast}
                    />
                    <button
                        type="button"
                        onClick={() => {
                            isModalAddLocationVisibleSet(true);
                        }}
                        className="add-location"
                        aria-label="Add location"
                    >
                        <img src={AddLocationIcon} className="add-location-icon" alt="" aria-hidden="true" />
                    </button>
                </div>
                {/* </AddLocationButton> */}
            </div>
        </div>
    );
};

export default FooterAutoNav;
