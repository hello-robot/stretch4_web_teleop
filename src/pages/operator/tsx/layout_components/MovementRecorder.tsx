import React, { useEffect, useLayoutEffect, useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { movementRecorderFunctionProvider } from "operator/tsx/index";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import IconRecord from "operator/icons/Record.svg";
import IconRecordPressed from "operator/icons/Record_Pressed.svg";
import MagneticWrapper from "../static_components/MagneticWrapper";
import ModalMobile from "../basic_components/ModalMobile";
import Flex from "../basic_components/Flex";
import { ButtonCancelPlayback } from '../static_components/ButtonCancelPlayback';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import SearchIcon from '@mui/icons-material/Search';
import LocalFloristIcon from '@mui/icons-material/LocalFlorist';
import { SharedState } from "./CustomizableComponent";
import { MovementState, movementStatesTerminal, movementStatesTransitory } from "robot/tsx/robot";
import { PlaybackStatusbar, StatusbarType } from "../basic_components/PlaybackStatusbar";
import InfiniteCarousel from "../basic_components/InfiniteCarousel";
import { ANIMS_STATUSBAR } from "../basic_components/PlaybackStatusbar";
import RecordingItem from "../static_components/RecordingItem";
import { ConfirmOverlay } from "../basic_components/ConfirmOverlay";
import { HelperText } from "../static_components/HelperText";
import "operator/css/basic_components.css";
import "operator/css/MovementRecorder.css";

type PendingRecordingDelete = {
    recordingName: string,
    idxFixed: number,
};

// Statusbar display duration
const DELAYMS_STATUSBAR_BEFORE_HIDE = ANIMS_STATUSBAR * 2;

// Button pad reveal delay
const DELAYMS_BUTTONPAD = ANIMS_STATUSBAR * 2;

/** Modal footer Flex: row-reverse when viewport height < this (px), else column */
const VIEWPORT_HEIGHT_MODAL_FOOTER_FLEX_BREAKPOINT_PX = 650;

/** Max length for the new-recording name field (save flow). */
export const MAX_RECORDING_NAME_LENGTH = 30;

/** All the possible button functions */
export enum MovementRecorderFunction {
    Record,
    SaveRecording,
    StopRecording,
    SavedRecordingNames,
    DeleteRecording,
    LoadRecording,
    LoadRecordingName,
    Cancel,
    DeleteRecordingName,
    RenameRecording,
    GetPinnedRecordingNames,
    SetPinnedRecordingNames,
}

export interface MovementRecorderFunctions {
    Record: (
        arm: boolean,
        lift: boolean,
        wrist_roll: boolean,
        wrist_pitch: boolean,
        wrist_yaw: boolean,
        gripper: boolean,
    ) => void;
    SaveRecording: (name: string) => void;
    StopRecording: () => void;
    SavedRecordingNames: () => string[];
    DeleteRecording: (recordingID: number) => void;
    LoadRecording: (recordingID: number) => void;
    RenameRecording: (recordingID: number, recordingNameNew: string) => void;
    Cancel: () => void;
    GetPinnedRecordingNames: () => string[];
    SetPinnedRecordingNames: (names: string[]) => void;
}

/*********************************
 * Primary Call-to-Action Button *
 *********************************/
const ButtonCTA = (props: {
    showRecordingStartButton: boolean;
    showRecordingStartButtonSet: React.Dispatch<React.SetStateAction<boolean>>;
    isRecording: boolean;
    isRecordingSet: React.Dispatch<React.SetStateAction<boolean>>;
    isOneJointSelected: boolean;
    startRecording: () => void;
    stopRecording: () => void;
    saveRecording: (name: string) => void;
    recordingsSet: React.Dispatch<React.SetStateAction<string[]>>;
    deselectAllJoints: () => void;
    isNamingModalVisibleSet: (arg0: boolean) => void;
    recordingName: string;
    recordingNameSet: React.Dispatch<React.SetStateAction<string>>;
    setCameraVeilCallback: ((visible: boolean) => void) | undefined;
    openModal: () => void;
    isPlaybackStatusbarVisibleSet: React.Dispatch<React.SetStateAction<boolean>>;
    typePlaybackStatusbarSet: React.Dispatch<React.SetStateAction<StatusbarType | null>>;
    childrenPlaybackStatusbarSet: React.Dispatch<React.SetStateAction<React.ReactNode | null>>;
    handleSaveRecording: () => void;
    recordingsCount: number;
    isRecordingNameDuplicate: boolean;
}) => {
    /////////////////////////
    //// "Record" button ////
    /////////////////////////
    if (
        !props.showRecordingStartButton
        && !props.isRecording
    ) {
        return (
            <button
                onPointerDown={() => props.showRecordingStartButtonSet(true)}
                className="btn btn-tertiary mrecord-modal-cta-btn"
            >
                <RadioButtonCheckedIcon color="primary" fontSize="small" />
                Create {!props.recordingsCount ? 'Your First' : 'New'} Recording
            </button>
        );
    }
    ////////////////////////
    //// "Start" button ////
    ////////////////////////
    else if (
        props.showRecordingStartButton
        && !props.isRecording
    ) {
        return (
            <button
                onPointerDown={props.startRecording}
                disabled={!props.isOneJointSelected}
                className={`btn btn-primary mrecord-modal-cta-btn ${props.isOneJointSelected ? 'glow' : ''}`}
            >
                <span className="mrecord-modal-cta-icon">
                    <RadioButtonCheckedIcon htmlColor={props.isOneJointSelected ? '#ffffff' : 'hsla(204, 100%, 65%, 1)'} fontSize="small" />
                </span>
                Start Recording
            </button>
        );
    }
    ///////////////////////
    //// "Save" button ////
    ///////////////////////
    else if (props.isRecording) {
        const canSave =
            props.recordingName.length > 0
            && !props.isRecordingNameDuplicate;
        return (
            <button
                onPointerDown={props.handleSaveRecording}
                className={`btn btn-primary mrecord-modal-cta-btn ${canSave ? 'glow' : ''}`}
                disabled={!canSave}
            >
                <span className="mrecord-modal-cta-icon">
                    <RadioButtonCheckedIcon htmlColor={'#ffffff'} fontSize="small" />
                </span>
                Save Recording
            </button>
        );
    }
}

/******************************
 * MovementRecorder component *
 ******************************/
interface MovementRecorderProps {
    sharedState: SharedState;
    isCameraVeilVisible: boolean;
    setCameraVeilCallback?: (visible: boolean) => void;
    isRecording: boolean;
    isRecordingSet: React.Dispatch<React.SetStateAction<boolean>>;
}

export const MovementRecorder = (props: MovementRecorderProps) => {
    const functions = useMemo((): MovementRecorderFunctions => ({
        Record: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.Record,
        ) as (
            arm: boolean,
            lift: boolean,
            wrist_roll: boolean,
            wrist_pitch: boolean,
            wrist_yaw: boolean,
            gripper: boolean,
        ) => void,
        SaveRecording: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SaveRecording,
        ) as (name: string) => void,
        StopRecording: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.StopRecording,
        ) as () => void,
        SavedRecordingNames: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SavedRecordingNames,
        ) as () => string[],
        DeleteRecording: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.DeleteRecording,
        ) as (recordingID: number) => void,
        LoadRecording: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.LoadRecording,
        ) as (recordingID: number) => void,
        RenameRecording: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.RenameRecording,
        ) as (recordingID: number, recordingNameNew: string) => void,
        Cancel: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.Cancel,
        ) as () => void,
        GetPinnedRecordingNames: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.GetPinnedRecordingNames,
        ) as () => string[],
        SetPinnedRecordingNames: movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SetPinnedRecordingNames,
        ) as (names: string[]) => void,
    }), []);

    const {
        playbackPosesState,
        idxFixedRecordingPlaying,
        idxFixedRecordingPlayingSet
    } = props.sharedState;

    const [isModalOpen, isModalOpenSet] = React.useState<boolean>(false);

    useEffect(() => {
        movementRecorderFunctionProvider.setModalOpenHandler((open) => {
            isModalOpenSet(open);
            props.setCameraVeilCallback?.(open);
        });
        movementRecorderFunctionProvider.setCameraVeilHandler((visible) => {
            props.setCameraVeilCallback?.(visible);
        });
        movementRecorderFunctionProvider.setIdxFixedRecordingPlayingHandler((idx) => {
            idxFixedRecordingPlayingSet(idx);
        });
        movementRecorderFunctionProvider.setRefreshRecordingsHandler(() => {
            recordingsSet(functions.SavedRecordingNames());
        });
        return () => {
            movementRecorderFunctionProvider.setModalOpenHandler(undefined);
            movementRecorderFunctionProvider.setCameraVeilHandler(undefined);
            movementRecorderFunctionProvider.setIdxFixedRecordingPlayingHandler(undefined);
            movementRecorderFunctionProvider.setRefreshRecordingsHandler(undefined);
        };
    }, [props.setCameraVeilCallback, idxFixedRecordingPlayingSet, functions]);

    useEffect(() => {
        if (isModalOpen) {
            recordingsSet(functions.SavedRecordingNames());
        }
    }, [isModalOpen, functions]);

    /*******************
     * Joint selection *
     *******************/
    const [arm, setArm] = React.useState<boolean>(false);
    const [lift, setLift] = React.useState<boolean>(false);
    const [wristRoll, setWristRoll] = React.useState<boolean>(false);
    const [wristPitch, setWristPitch] = React.useState<boolean>(false);
    const [wristYaw, setWristYaw] = React.useState<boolean>(false);
    const [gripper, setGripper] = React.useState<boolean>(false);
    const [isPlaybackStatusbarVisible, isPlaybackStatusbarVisibleSet] = React.useState<boolean>(false);
    const [typePlaybackStatusbar, typePlaybackStatusbarSet] = React.useState<StatusbarType>('info');
    const [childrenPlaybackStatusbar, childrenPlaybackStatusbarSet] = React.useState<React.ReactNode | null>(null);
    const [isOneJointSelected, isOneJointSelectedSet] = React.useState<boolean>(false);
    const selectAllJoints = useCallback(() => {
        setArm(true);
        setLift(true);
        setWristRoll(true);
        setWristPitch(true);
        setWristYaw(true);
        setGripper(true);
    }, []);
    const deselectAllJoints = useCallback(() => {
        setArm(false);
        setLift(false);
        setWristRoll(false);
        setWristPitch(false);
        setWristYaw(false);
        setGripper(false);
    }, []);

    // Effect to check if at least one joint is selected
    useEffect(() => {
        isOneJointSelectedSet(
            arm
            || lift
            || wristRoll
            || wristPitch
            || wristYaw
            || gripper
        );
    }, [arm, lift, wristRoll, wristPitch, wristYaw, gripper]);

    // For Arm & Lift
    const armLiftAllChecked = arm && lift;
    const armLiftNoneChecked = !arm && !lift;
    const armLiftIndeterminate = !armLiftAllChecked && !armLiftNoneChecked;

    const armLiftRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (armLiftRef.current) {
            armLiftRef.current.indeterminate = armLiftIndeterminate;
        }
    }, [armLiftIndeterminate]);

    const handleArmLiftParentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setArm(e.target.checked);
        setLift(e.target.checked);
    };

    // For Wrist & Gripper
    const wristGripperAllChecked = wristRoll && wristPitch && wristYaw && gripper;
    const wristGripperNoneChecked = !wristRoll && !wristPitch && !wristYaw && !gripper;
    const wristGripperIndeterminate = !wristGripperAllChecked && !wristGripperNoneChecked;

    const wristGripperRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (wristGripperRef.current) {
            wristGripperRef.current.indeterminate = wristGripperIndeterminate;
        }
    }, [wristGripperIndeterminate]);

    const handleWristGripperParentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setWristRoll(e.target.checked);
        setWristPitch(e.target.checked);
        setWristYaw(e.target.checked);
        setGripper(e.target.checked);
    };


    /*************
     * Recording *
     *************/
    const [recordings, recordingsSet] = useState<string[]>(
        functions.SavedRecordingNames(),
    );
    const [showRecordingStartButton, showRecordingStartButtonSet] =
        useState<boolean>(false);
    const [isNamingModalVisible, isNamingModalVisibleSet] = React.useState<boolean>(false);
    const [recordingName, recordingNameSet] = React.useState<string>('');

    // Start recording with current joint selections
    const startRecording = useCallback(() => {

        // Close modal
        closeModal();

        // Reveal camera and controls
        props.setCameraVeilCallback(false);

        // Show statusbar
        isPlaybackStatusbarVisibleSet(true);
        typePlaybackStatusbarSet('info_bright');
        childrenPlaybackStatusbarSet(
            <div className="mrecord-statusbar-row">
                <span className="recording-icon-blink" />
                Recording
            </div>
        );

        showRecordingStartButtonSet(false);
        props.isRecordingSet(true);
        functions.Record(
            arm,
            lift,
            wristRoll,
            wristPitch,
            wristYaw,
            gripper,
        );
    }, [arm, lift, wristRoll, wristPitch, wristYaw, gripper]);



    /*******************************
     * Filter state & side-effects *
     *******************************/
    const [isFilterActivated, isFilterActivatedSet] =
        useState<boolean>(false);
    const [filterQuery, filterQuerySet] = useState<string>('');
    const recordingsFiltered = recordings.filter(recording =>
        recording.toLowerCase().includes(filterQuery.toLowerCase().trim())
    );

    const [pinnedRecordingNames, pinnedRecordingNamesSet] = useState<
        string[]
    >(() => functions.GetPinnedRecordingNames());

    useEffect(() => {
        pinnedRecordingNamesSet(functions.GetPinnedRecordingNames());
    }, [recordings, functions]);

    const recordingsDisplayOrdered = useMemo(() => {
        const pinnedSet = new Set(pinnedRecordingNames);
        const pinnedInOrder = pinnedRecordingNames.filter((n) =>
            recordingsFiltered.includes(n),
        );
        const rest = recordingsFiltered
            .filter((n) => !pinnedSet.has(n))
            // Sort alphabetically
            .sort((a, b) => a.localeCompare(b));
        return [...pinnedInOrder, ...rest];
    }, [recordingsFiltered, pinnedRecordingNames]);

    const togglePin = useCallback(
        (recordingName: string) => {
            const current = functions.GetPinnedRecordingNames();
            const next = current.includes(recordingName)
                ? current.filter((n) => n !== recordingName)
                : [
                    recordingName,
                    ...current.filter((n) => n !== recordingName),
                ];
            functions.SetPinnedRecordingNames(next);
            pinnedRecordingNamesSet(functions.GetPinnedRecordingNames());
        },
        [functions],
    );

    const [deleteConfirmation, deleteConfirmationSet] = useState<PendingRecordingDelete | null>(null);

    const requestDeleteConfirm = useCallback((payload: PendingRecordingDelete) => {
        deleteConfirmationSet(payload);
    }, []);

    const handleConfirmDeleteRecording = useCallback(() => {
        if (!deleteConfirmation) return;
        const idx = recordings.indexOf(deleteConfirmation.recordingName);
        if (idx >= 0) {
            functions.DeleteRecording(idx);
            recordingsSet(functions.SavedRecordingNames());
            pinnedRecordingNamesSet(functions.GetPinnedRecordingNames());
        }
        deleteConfirmationSet(null);
    }, [deleteConfirmation, recordings, functions]);

    useEffect(() => {
        if (!isModalOpen || showRecordingStartButton || isNamingModalVisible) {
            deleteConfirmationSet(null);
        }
    }, [isModalOpen, showRecordingStartButton, isNamingModalVisible]);



    /********************************************
     * Callback to go back to the drawing board *
     ********************************************/
    const dumpToInitialState = useCallback(() => {
        filterQuerySet('');
        isFilterActivatedSet(false);
        showRecordingStartButtonSet(false);
        deselectAllJoints();
        props.isRecordingSet(false);
        functions.StopRecording();
        isNamingModalVisibleSet(false);
        deleteConfirmationSet(null);
    }, []);



    /****************
     * Naming Modal *
     ****************/
    // ref for <input>
    const refInputRecordingName = useRef<HTMLInputElement>(null);

    /** Focus; optionally select all (`setSelectionRange` tracks better on iOS than `select()` alone). */
    const focusRecordingNameInput = useCallback((options?: { selectAll?: boolean }) => {
        const el = refInputRecordingName.current;
        if (!el) return;
        el.focus({ preventScroll: true, });
        const shouldSelect = options?.selectAll !== false;
        if (!shouldSelect) return;
        const selectAll = () => {
            const n = el.value.length;
            try {
                el.setSelectionRange(0, n);
            } catch {
                el.select();
            }
        };
        selectAll();
        requestAnimationFrame(selectAll);
    }, []);

    // Auto-select text inside of <input>
    // when naming modal is visible
    useEffect(() => {
        if (isNamingModalVisible) {
            requestAnimationFrame(() => focusRecordingNameInput());
        }
    }, [isNamingModalVisible, focusRecordingNameInput]);



    /*********************************************
     * Unset index to -1 when playback ended     *
     * due to success, canceled, or failed state *
     *********************************************/
    const playbackTerminated = movementStatesTerminal.includes(playbackPosesState?.state as MovementState)

    // When playback ends, whether due to
    // success, cancellation, or failure
    // we want cleanup the state here
    useEffect(() => {
        if (playbackTerminated) {
            idxFixedRecordingPlayingSet(-1)
        };
    }, [playbackPosesState?.state]);

    // Simply hides modal without revealing the Piloting controls
    const openModal = useCallback(() => {
        isModalOpenSet(true);
    }, [])

    // Simply hides modal without revealing the Piloting controls
    const closeModal = useCallback(() => {
        isModalOpenSet(false);
    }, [])

    // Hides modal and reveals the Piloting controls
    const handleClose = () => {
        closeModal();
        props.setCameraVeilCallback(false);
    };

    const titleCalc = useCallback(() => {
        if (!showRecordingStartButton && !isNamingModalVisible) {
            return "Movement"
        } else if (showRecordingStartButton && !isNamingModalVisible) {
            return "Select Robot Movements to Record"
        } else if (isNamingModalVisible) {
            return "Your Recording"
        }
    }, [isNamingModalVisible, showRecordingStartButton]);
    const subtitleCalc = useCallback(() => {
        if (!isNamingModalVisible) {
            return "SELECT"
        } else return "NAME"
    }, [isNamingModalVisible]);

    // Handlers for fuzzy filter
    const activateFilter = useCallback(() => isFilterActivatedSet(true), []);
    const deactivateFilter = useCallback(() => {
        isFilterActivatedSet(false)
        filterQuerySet('')
    }, []);

    // Create a temporary name for the recording.
    // Ideally, the user personalizes their recording
    // name before saving, but this at least gives them
    const recordingNameCreate = useCallback(() => {
        const tempName = '';
        recordingNameSet(tempName.slice(0, MAX_RECORDING_NAME_LENGTH));
    }, []);

    const isRecordingNameDuplicate = useMemo(
        () => recordings.includes(recordingName),
        [recordings, recordingName],
    );

    const isRecordingNameAtMaxLength = useMemo(
        () => isNamingModalVisible && recordingName.length >= MAX_RECORDING_NAME_LENGTH,
        [isNamingModalVisible, recordingName],
    );

    // When duplicate-name hint shows, re-focus after DOM + Framer update. Extra delayed runs help
    // iOS/WebKit and beat ModalMobile enter animation (200ms delay on `.modal-content-wrapper.enter`).
    useLayoutEffect(() => {
        if (
            !isNamingModalVisible
            || (!isRecordingNameDuplicate && !isRecordingNameAtMaxLength)
        ) {
            return;
        }
        const ids: ReturnType<typeof setTimeout>[] = [];
        const run = () => focusRecordingNameInput({ selectAll: false, });
        run();
        ids.push(setTimeout(run, 0));
        ids.push(setTimeout(run, 50));
        ids.push(setTimeout(run, 280));
        return () => ids.forEach(clearTimeout);
    }, [
        isRecordingNameDuplicate,
        isRecordingNameAtMaxLength,
        isNamingModalVisible,
        focusRecordingNameInput,
    ]);

    // When user clicks "Save Recording"...
    const handleSaveRecording = useCallback(() => {
        if (
            !recordingName.length
            || recordings.includes(recordingName)
            || recordingName.length > MAX_RECORDING_NAME_LENGTH
        ) {
            return;
        }

        // Show statusbar
        isPlaybackStatusbarVisibleSet(true);
        typePlaybackStatusbarSet('success');
        childrenPlaybackStatusbarSet(<div>{recordingName} <span className="mrecord-statusbar-muted">saved</span></div>);

        // Update list of recordings
        recordingsSet((recordings) => [recordingName, ...recordings]);
        // Save recording
        functions.SaveRecording(recordingName);

        // Reset state
        dumpToInitialState();
        closeModal();
        props.setCameraVeilCallback(false);

        // Hide statusbar
        setTimeout(() => {
            isPlaybackStatusbarVisibleSet(false)
        }, DELAYMS_STATUSBAR_BEFORE_HIDE);
    }, [
        recordingName,
        recordings,
        functions,
        props.setCameraVeilCallback,
        dumpToInitialState,
        closeModal,
    ]);

    // When user clicks "Discard"...
    const handleDiscardRecording = useCallback(() => {

        // Show statusbar
        isPlaybackStatusbarVisibleSet(true);
        typePlaybackStatusbarSet('info');
        childrenPlaybackStatusbarSet(<div>Recording <span className="mrecord-statusbar-muted">discarded</span></div>);

        // Reset state
        closeModal();
        dumpToInitialState();
        hideStatusBar();
    }, []);

    // Set modal footer Flex direction based on viewport height
    const [modalFooterFlexDirection, modalFooterFlexDirectionSet] = useState<
        'column' | 'row-reverse'
    >(() =>
        typeof window !== 'undefined'
            && window.innerHeight < VIEWPORT_HEIGHT_MODAL_FOOTER_FLEX_BREAKPOINT_PX
            ? 'row-reverse'
            : 'column',
    );

    // Detect viewport height change
    // and set modal footer Flex direction accordingly
    useEffect(() => {
        const query = `(max-height: ${VIEWPORT_HEIGHT_MODAL_FOOTER_FLEX_BREAKPOINT_PX - 1}px)`;
        const mq = window.matchMedia(query);
        const sync = () => {
            modalFooterFlexDirectionSet(mq.matches ? 'row-reverse' : 'column');
        };
        sync();
        mq.addEventListener('change', sync);
        return () => mq.removeEventListener('change', sync);
    }, []);

    // Set modal footer justify
    // based on flex direction
    const modalFooterJustify =
        modalFooterFlexDirection === 'row-reverse' ? 'flex-end' : 'flex-start';

    // Content for modal footer
    const modalFooterContent = (
        <Flex
            direction={modalFooterFlexDirection}
            justify={modalFooterJustify}
            gap={5}
            flex={1}
            className={`mrecord-modal-footer ${modalFooterFlexDirection ? 'children-limit-width' : ''}`}
        >
            <MagneticWrapper>
                <ButtonCTA
                    showRecordingStartButton={showRecordingStartButton}
                    showRecordingStartButtonSet={showRecordingStartButtonSet}
                    isRecording={props.isRecording}
                    isRecordingSet={props.isRecordingSet}
                    isOneJointSelected={isOneJointSelected}
                    startRecording={startRecording}
                    stopRecording={functions.StopRecording}
                    saveRecording={functions.SaveRecording}
                    recordingsSet={recordingsSet}
                    deselectAllJoints={deselectAllJoints}
                    isNamingModalVisibleSet={isNamingModalVisibleSet}
                    recordingName={recordingName}
                    recordingNameSet={recordingNameSet}
                    setCameraVeilCallback={props.setCameraVeilCallback}
                    openModal={openModal}
                    isPlaybackStatusbarVisibleSet={isPlaybackStatusbarVisibleSet}
                    typePlaybackStatusbarSet={typePlaybackStatusbarSet}
                    childrenPlaybackStatusbarSet={childrenPlaybackStatusbarSet}
                    handleSaveRecording={handleSaveRecording}
                    recordingsCount={recordings.length}
                    isRecordingNameDuplicate={isRecordingNameDuplicate}
                />
            </MagneticWrapper>
            {!showRecordingStartButton && !isNamingModalVisible
                ? (<MagneticWrapper>
                    <button
                        className="btn btn-tertiary"
                        onPointerDown={handleClose}
                    >
                        Close
                    </button>
                </MagneticWrapper>)
                : !isNamingModalVisible
                    ? (
                        <MagneticWrapper>
                            <button
                                className="btn btn-tertiary"
                                onPointerDown={dumpToInitialState}
                            >
                                Back
                            </button>
                        </MagneticWrapper>
                    )
                    : (
                        <MagneticWrapper>                            <button
                            className="btn btn-tertiary"
                            onPointerDown={handleDiscardRecording}
                        >
                            Discard
                        </button>
                        </MagneticWrapper>
                    )}
        </Flex>
    );

    // Content for modal header
    const headerControls = (
        <div className={`mrecord-search-controls ${isFilterActivated ? 'active' : ''}`}>
            <AnimatePresence mode="wait" initial={false}>
                {!isFilterActivated
                    ? (
                        <motion.button
                            key="search-btn"
                            className="mrecord-search-btn"
                            onClick={activateFilter}
                            aria-label="Search recordings"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            transition={{ duration: 0.2 }}
                        >
                            <SearchIcon />
                        </motion.button>
                    )
                    : (
                        <motion.div
                            key="search-input"
                            className="mrecord-search-input-wrapper"
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ duration: 0.2 }}
                        >
                            <motion.button
                                className={`mrecord-search-close-btn ${filterQuery.trim().length ? 'active' : ''}`}
                                onClick={deactivateFilter}
                                aria-label="Close search"
                            >
                                <ChevronLeftIcon />
                            </motion.button>
                            <input
                                type="text"
                                className="mrecord-search-input"
                                placeholder="Type to filter..."
                                value={filterQuery}
                                onChange={e => filterQuerySet(e.target.value)}
                                autoFocus
                            />
                        </motion.div>
                    )
                }
            </AnimatePresence>
        </div>
    );

    const handleToggleModal = useCallback(() => {
        const newModalState = !isModalOpen;
        isModalOpenSet(newModalState);
        props.setCameraVeilCallback?.(newModalState);
    }, [isModalOpen, props.setCameraVeilCallback]);

    const isButtonVisible = !props.isCameraVeilVisible;

    // Determine if any recording
    // is currently playing (including this one)
    const isRecordingPlaying = movementStatesTransitory.includes(playbackPosesState?.state as MovementState);

    const showButtonPadWithDelay = useCallback(() => {
        setTimeout(() => { props.setCameraVeilCallback(false) }, DELAYMS_BUTTONPAD)
    }, []);

    const handlePlaybackCancel = useCallback(() => {

        const recordingName = recordings[idxFixedRecordingPlaying];

        childrenPlaybackStatusbarSet(
            <div className="mrecord-statusbar-row mrecord-statusbar-row--loose">
                {recordingName} <span className="mrecord-statusbar-muted">canceled</span>
            </div>
        );

        typePlaybackStatusbarSet('warning');
        hideStatusBar();
        idxFixedRecordingPlayingSet(-1);
        functions.Cancel();
    }, [idxFixedRecordingPlaying, idxFixedRecordingPlayingSet, functions]);

    const hideStatusBar = useCallback(() => {
        setTimeout(() => {
            isPlaybackStatusbarVisibleSet(false);
            showButtonPadWithDelay();
        }, DELAYMS_STATUSBAR_BEFORE_HIDE)
    }, []);

    useEffect(() => {

        const recordingName = recordings[idxFixedRecordingPlaying];

        // Playback failed
        if (playbackPosesState?.state === MovementState.Fail) {
            childrenPlaybackStatusbarSet(
                <div className="mrecord-statusbar-row mrecord-statusbar-row--loose">
                    {recordingName} <span className="mrecord-statusbar-muted">failed</span>
                </div>
            );
            typePlaybackStatusbarSet('error');
            setTimeout(() => {
                isPlaybackStatusbarVisibleSet(false);
                showButtonPadWithDelay();
            }, DELAYMS_STATUSBAR_BEFORE_HIDE * 4)
        }
    }, [playbackPosesState?.state]);

    // Stop recording
    const handleStopRecording = useCallback(() => {

        // Hide statusbar
        isPlaybackStatusbarVisibleSet(false);

        // Create a temporary recording name
        recordingNameCreate();

        // Show naming modal
        isNamingModalVisibleSet(true);

        // Reveal modal
        openModal();

        // Hide piloting controls and show camera veil
        props.setCameraVeilCallback(true);
    }, []);

    return (
        <div className="mrecord">
            {/* MR Button element in the corner of screen */}
            <motion.div
                className={`mrecord-button-wrapper ${!isButtonVisible ? 'mrecord-button-wrapper--inert' : ''}`}
                initial={false}
                animate={{
                    opacity: isButtonVisible ? 1 : 0,
                }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                aria-hidden={!isButtonVisible}
            >
                {!props.isRecording
                    ? (
                        // Modal toggle
                        <button
                            onPointerUp={handleToggleModal}
                            className="mrecord-button"
                            tabIndex={isButtonVisible ? 0 : -1}
                            disabled={!isButtonVisible}
                        >
                            <div className="mrecord-button-background" />
                            <div className="mrecord-button-border" />
                            <img src={IconRecordPressed} alt="Movement Recording Icon" draggable="false" />
                            <img src={IconRecord} alt="Movement Recording Icon" draggable="false" />
                        </button>
                    )
                    : (
                        // Button to stop recording
                        <button
                            onPointerUp={handleStopRecording}
                            className="mrecord-stop-button"
                            tabIndex={isButtonVisible ? 0 : -1}
                            disabled={!isButtonVisible}
                        >
                            {/* Red square */}
                            <div className="stop-button-red-square" />
                        </button>
                    )}
            </motion.div>

            <PlaybackStatusbar
                isVisible={isPlaybackStatusbarVisible}
                type={typePlaybackStatusbar}
            >
                {childrenPlaybackStatusbar}
            </PlaybackStatusbar>

            <ButtonCancelPlayback
                isRecordingPlaying={isRecordingPlaying}
                handlePlaybackCancel={handlePlaybackCancel}
            />

            <ModalMobile
                isOpen={isModalOpen}
                title={titleCalc()}
                subtitle={subtitleCalc()}
                footer={modalFooterContent}
                modalClassName="mrecord-modal"
                HeaderControls={
                    // Only show fuzzy filter in the initial screen
                    // and not when selecting joints, or naming recording
                    !showRecordingStartButton && !isNamingModalVisible && recordings.length > 0
                        ? headerControls
                        : null
                }
            >
                <div id="movement-recorder-container">
                    <div className={`recordings-list ${showRecordingStartButton || isNamingModalVisible ? 'hidden' : ''} ${!recordingsFiltered.length ? 'empty' : ''}`}>
                        {
                            recordings.length === 0 || recordingsFiltered.length === 0
                                ? (
                                    <div className="helper-text-empty-state">
                                        {!recordings.length && <div><LocalFloristIcon fontSize="large" /></div>}
                                        <div className="copy">{
                                            !recordings.length
                                                ? "No recordings"
                                                : recordings.length > 0 && `No results for "${filterQuery.trim()}"`
                                        }</div>
                                    </div>
                                )
                                : (
                                    <InfiniteCarousel<{ recordingName: string; idxFixed: number }>
                                        ref={null}
                                        isHidden={!isModalOpen}
                                        numOfColumns={1}
                                        numOfRows={4}
                                        keyExtractor={(recording) => recording.recordingName}
                                        className="scene-carousel-container"
                                        items={recordingsDisplayOrdered.map((recordingName) => ({
                                            recordingName,
                                            idxFixed: recordings.indexOf(recordingName),
                                        }))}
                                        renderItem={({ recordingName, idxFixed }) => (
                                            <RecordingItem
                                                key={recordingName + idxFixed}
                                                recordingName={recordingName}
                                                idxFixed={idxFixed}
                                                functions={functions}
                                                recordingsSet={recordingsSet}
                                                playbackPosesState={playbackPosesState}
                                                idxFixedRecordingPlaying={idxFixedRecordingPlaying}
                                                idxFixedRecordingPlayingSet={idxFixedRecordingPlayingSet}
                                                isRecordingPlaying={isRecordingPlaying}
                                                closeModal={closeModal}
                                                setCameraVeilCallback={props.setCameraVeilCallback}
                                                showButtonPadWithDelay={showButtonPadWithDelay}
                                                typePlaybackStatusbarSet={typePlaybackStatusbarSet}
                                                childrenPlaybackStatusbarSet={childrenPlaybackStatusbarSet}
                                                isPlaybackStatusbarVisibleSet={isPlaybackStatusbarVisibleSet}
                                                onRequestDeleteConfirm={requestDeleteConfirm}
                                                isPinned={pinnedRecordingNames.includes(recordingName)}
                                                onTogglePin={togglePin}
                                            />
                                        )}
                                    />
                                )
                        }
                        <ConfirmOverlay
                            open={deleteConfirmation != null}
                            presenceKey={
                                deleteConfirmation
                                    ? `${deleteConfirmation.recordingName}-${deleteConfirmation.idxFixed}`
                                    : undefined
                            }
                            title="Delete this recording?"
                            body={deleteConfirmation?.recordingName}
                            cancelLabel="Cancel"
                            confirmLabel="Confirm"
                            onCancel={() => { deleteConfirmationSet(null); }}
                            onConfirm={handleConfirmDeleteRecording}
                        />
                    </div>
                    {
                        showRecordingStartButton
                            ? (
                                <div className="joints-list">
                                    <button
                                        onPointerDown={!isOneJointSelected ? selectAllJoints : deselectAllJoints}
                                        disabled={props.isRecording}
                                        className={`btn ${!isOneJointSelected ? "btn-primary" : "btn-tertiary"}`}
                                    >
                                        {!isOneJointSelected ? "Select All" : "Deselect All"
                                        }
                                    </button>
                                    <ul className="checkboxes">
                                        <li>
                                            <input
                                                type="checkbox"
                                                id="arm-lift"
                                                ref={armLiftRef}
                                                checked={armLiftAllChecked}
                                                onChange={handleArmLiftParentChange}
                                                disabled={props.isRecording}
                                            />
                                            <label htmlFor="arm-lift"> Arm & Lift </label>
                                            <ul className="checkboxes nested">
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="arm"
                                                        name="save-arm-pose"
                                                        value="Arm"
                                                        checked={arm}
                                                        onChange={(e) => setArm(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="arm"> Arm </label>
                                                </li>
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="lift"
                                                        name="save-lift-pose"
                                                        value="Lift"
                                                        checked={lift}
                                                        onChange={(e) => setLift(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="lift"> Lift </label>
                                                </li>
                                            </ul>
                                        </li>
                                        <li>
                                            <input
                                                type="checkbox"
                                                id="wrist-gripper"
                                                ref={wristGripperRef}
                                                checked={wristGripperAllChecked}
                                                onChange={handleWristGripperParentChange}
                                                disabled={props.isRecording}
                                            />
                                            <label htmlFor="wrist-gripper"> Wrist & Hand </label>
                                            <ul className="checkboxes nested">
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="wristRoll"
                                                        name="save-wrist-roll-pose"
                                                        value="Wrist Roll"
                                                        checked={wristRoll}
                                                        onChange={(e) => setWristRoll(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="wristRoll"> Wrist Rotate </label>
                                                </li>
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="wristPitch"
                                                        name="save-wrist-pitch-pose"
                                                        value="Wrist Pitch"
                                                        checked={wristPitch}
                                                        onChange={(e) => setWristPitch(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="wristPitch"> Wrist Bend </label>
                                                </li>
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="wristYaw"
                                                        name="save-wrist-yaw-pose"
                                                        value="Wrist Yaw"
                                                        checked={wristYaw}
                                                        onChange={(e) => setWristYaw(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="wristYaw"> Wrist Turn Left/Right </label>
                                                </li>
                                                <li>
                                                    <input
                                                        type="checkbox"
                                                        id="gripper"
                                                        name="save-gripper-pose"
                                                        value="Gripper"
                                                        checked={gripper}
                                                        onChange={(e) => setGripper(e.target.checked)}
                                                        disabled={props.isRecording}
                                                    />
                                                    <label htmlFor="gripper"> Hand </label>
                                                </li>
                                            </ul>
                                        </li>
                                    </ul>
                                </div>
                            )
                            : null}

                    {
                        isNamingModalVisible
                            ? (
                                <Flex className="naming-modal" direction="column">
                                    <input
                                        type="text"
                                        ref={refInputRecordingName}
                                        value={recordingName}
                                        maxLength={MAX_RECORDING_NAME_LENGTH}
                                        onFocus={(e) => {
                                            if (!isRecordingNameDuplicate && !isRecordingNameAtMaxLength) {
                                                e.target.select();
                                            }
                                        }}
                                        onChange={(e) => recordingNameSet(e.target.value)}
                                        aria-invalid={isRecordingNameDuplicate}
                                        aria-describedby={
                                            isRecordingNameDuplicate || isRecordingNameAtMaxLength
                                                ? 'mrecord-naming-duplicate-msg'
                                                : undefined
                                        }
                                    />
                                    <HelperText
                                        show={isRecordingNameDuplicate || isRecordingNameAtMaxLength}
                                        variant={isRecordingNameDuplicate ? 'error' : 'warning'}
                                        fontSize={13}
                                        id="mrecord-naming-duplicate-msg"
                                    >
                                        {isRecordingNameDuplicate
                                            ? 'You already have a recording with this name.'
                                            : `Use ${MAX_RECORDING_NAME_LENGTH} characters or less`}
                                    </HelperText>
                                </Flex>
                            )
                            : null
                    }
                </div>
            </ModalMobile>
        </div>
    );
};
