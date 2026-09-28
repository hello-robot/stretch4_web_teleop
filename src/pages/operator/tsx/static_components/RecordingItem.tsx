import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { motion } from "framer-motion";
import PlayArrow from "@mui/icons-material/PlayArrow";
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import Flex from "../basic_components/Flex";
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { ActionState } from "shared/util";
import { MovementState } from "robot/tsx/robot";
import Ellipsis from "../basic_components/Ellipsis";
import { StatusbarType } from "../basic_components/PlaybackStatusbar";
import { ANIMS_STATUSBAR } from "../basic_components/PlaybackStatusbar";
import { HelperText } from "./HelperText";
import { MAX_RECORDING_NAME_LENGTH } from "../layout_components/MovementRecorder";

// We need a delay so that the modal
// has time to close before playback starts
const DELAYMS_PLAYBACK_BEFORE_START = 1000;

// Statusbar display duration
const DELAYMS_STATUSBAR_BEFORE_HIDE = ANIMS_STATUSBAR * 2;

const isLikelyIOS =
    typeof navigator !== "undefined" &&
    /iP(hone|ad|od)/.test(navigator.userAgent);

export interface RecordingItemProps {
    recordingName: string;
    idxFixed: number;
    functions: {
        LoadRecording: (idx: number) => void;
        RenameRecording: (idx: number, newName: string) => void;
        DeleteRecording: (idx: number) => void;
        SavedRecordingNames: () => string[];
        Cancel: () => void;
    };
    recordingsSet: React.Dispatch<React.SetStateAction<string[]>>;
    playbackPosesState: ActionState | undefined;
    idxFixedRecordingPlaying: number;
    idxFixedRecordingPlayingSet: React.Dispatch<React.SetStateAction<number>>;
    isRecordingPlaying: boolean;
    closeModal: () => void;
    setCameraVeilCallback?: (visible: boolean) => void;
    showButtonPadWithDelay: () => void;
    typePlaybackStatusbarSet: React.Dispatch<React.SetStateAction<StatusbarType | null>>;
    childrenPlaybackStatusbarSet: React.Dispatch<React.SetStateAction<React.ReactNode | null>>;
    isPlaybackStatusbarVisibleSet: React.Dispatch<React.SetStateAction<boolean>>;
    onRequestDeleteConfirm: (payload: { recordingName: string; idxFixed: number }) => void;
    isPinned: boolean;
    onTogglePin: (recordingName: string) => void;
}

/****************************
 * Recording Item Component *
 ****************************/
const RecordingItem: React.FC<RecordingItemProps> = ({
    recordingName,
    idxFixed,
    functions,
    recordingsSet,
    playbackPosesState,
    idxFixedRecordingPlaying,
    idxFixedRecordingPlayingSet,
    isRecordingPlaying,
    closeModal,
    setCameraVeilCallback,
    showButtonPadWithDelay,
    typePlaybackStatusbarSet,
    childrenPlaybackStatusbarSet,
    isPlaybackStatusbarVisibleSet,
    onRequestDeleteConfirm,
    isPinned,
    onTogglePin,
}: RecordingItemProps) => {
    const [valueTextArea, valueTextAreaSet] = useState<string>(
        recordingName.slice(0, MAX_RECORDING_NAME_LENGTH),
    );
    const refRecordingNameInput = useRef<HTMLInputElement>(null);
    const recordingsRefresh = useCallback(() => {
        recordingsSet(functions.SavedRecordingNames());
    }, []);
    const [isEditing, isEditingSet] = useState<boolean>(false);
    const isEditingRef = useRef(false);
    // iOS/WebKit: blur often fires before click and relatedTarget is null; pointerdown
    // capture on Save/Cancel runs before blur so we can skip mistaken "tap outside" cancel.
    const skipBlurDiscardRef = useRef(false);
    // Set on edit control pointer/touch so handleEditClick can apply readOnly hack only for
    // Voice Control / mouse-like activation — the hack breaks the normal touch keyboard path.
    const editActivationPointerTypeRef = useRef<string | null>(null);
    const isRecordingNameDuplicate = useMemo(() => {
        if (!isEditing) return false;
        const draft = valueTextArea.trim();
        if (!draft.length) return false;
        if (draft === recordingName) return false;
        return functions.SavedRecordingNames().includes(draft);
    }, [isEditing, valueTextArea, recordingName, functions]);

    /** With `maxLength={80}`, length cannot exceed 80; show when at cap while editing. */
    const isRecordingNameAtMaxLength = useMemo(
        () => isEditing && valueTextArea.length >= MAX_RECORDING_NAME_LENGTH,
        [isEditing, valueTextArea],
    );

    const recordingNameInputDescribedBy = useMemo(() => {
        const ids: string[] = [];
        if (isRecordingNameDuplicate) ids.push(`recording-item-dup-${idxFixed}`);
        if (isRecordingNameAtMaxLength) ids.push(`recording-item-len-${idxFixed}`);
        return ids.length ? ids.join(' ') : undefined;
    }, [isRecordingNameDuplicate, isRecordingNameAtMaxLength, idxFixed]);

    // This recording is playing right now
    const isThisPlaying = idxFixedRecordingPlaying === idxFixed;
    // Track previous value of `isThisPlaying`
    // in order to know when playback ends
    const wasPlayingRef = useRef<boolean>(false);

    // Disable all buttons if a recording
    // is playing and it's not this one
    const isDisabled = isRecordingPlaying && !isThisPlaying;

    useEffect(() => {
        isEditingRef.current = isEditing;
    }, [isEditing]);

    // Keep draft in sync when the saved name changes (e.g. after rename) while not editing
    useEffect(() => {
        if (!isEditing) {
            valueTextAreaSet(recordingName.slice(0, MAX_RECORDING_NAME_LENGTH));
        }
    }, [recordingName, isEditing]);

    // Update recording name
    const updateRecordingName = useCallback(() => {
        isEditingRef.current = false;
        const trimmed = refRecordingNameInput.current?.value.trim() ?? "";
        if (trimmed === recordingName) {
            isEditingSet(false);
            return;
        }
        if (trimmed.length > MAX_RECORDING_NAME_LENGTH) {
            isEditingRef.current = true;
            return;
        }
        if (
            trimmed.length > 0
            && functions.SavedRecordingNames().includes(trimmed)
            && trimmed !== recordingName
        ) {
            isEditingRef.current = true;
            return;
        }
        const recordingNameNew = trimmed || recordingName;

        functions.RenameRecording(idxFixed, recordingNameNew);
        recordingsRefresh();
        isEditingSet(false);
    }, [idxFixed, recordingName, functions, recordingsRefresh]);

    const playback = useCallback(async (idxFixed) => {
        setCameraVeilCallback(true);
        closeModal();

        // 1. Set optimistic state immediately so the Stop button renders 0ms after tap
        idxFixedRecordingPlayingSet(idxFixed);
        // 2. Call playback immediately (awaiting mode switch if async)
        await functions.LoadRecording(idxFixed);
    }, [closeModal, idxFixedRecordingPlayingSet, functions]);

    // Side-effects when playback starts/ends
    useEffect(() => {

        // Playback started
        if (!wasPlayingRef.current && isThisPlaying) {
            isPlaybackStatusbarVisibleSet(true);
            typePlaybackStatusbarSet('info');
            childrenPlaybackStatusbarSet(<div>{recordingName} <span style={{ opacity: 0.85 }}>playing&nbsp;<Ellipsis /></span></div>);
        }
        // Playback ended
        else if (wasPlayingRef.current && !isThisPlaying) {
            // Success
            if (playbackPosesState?.state === MovementState.Success) {
                childrenPlaybackStatusbarSet(
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {recordingName}
                        <motion.span
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                            style={{ display: 'flex' }}
                        >
                            <CheckCircleIcon style={{ color: 'hsla(204, 100%, 70%, 1)', fontSize: 20 }} />
                        </motion.span>
                    </div>
                );
                typePlaybackStatusbarSet('success');
                setTimeout(() => {
                    isPlaybackStatusbarVisibleSet(false);
                    showButtonPadWithDelay();
                }, DELAYMS_STATUSBAR_BEFORE_HIDE)
                // Cancel
            }
        }
        // Update ref for next render
        wasPlayingRef.current = isThisPlaying;
    }, [isThisPlaying]);

    // Handler for play/stop button
    const handlePlay = useCallback(() => {
        // Close the modal without
        // revealing Pilot controls...
        closeModal();
        // ...start playback!
        playback(idxFixed);
    }, [idxFixedRecordingPlaying, idxFixed, functions]);

    const handleEditClick = useCallback(() => {
        // Synchronous focus (after enabling the field) keeps iOS user-gesture context
        // so the software keyboard can open.
        flushSync(() => {
            valueTextAreaSet(recordingName.slice(0, MAX_RECORDING_NAME_LENGTH));
            isEditingSet(true);
        });
        isEditingRef.current = true;
        const el = refRecordingNameInput.current;
        if (!el) return;
        const pointerType = editActivationPointerTypeRef.current ?? "";
        editActivationPointerTypeRef.current = null;
        const isTouchLike = pointerType === "touch" || pointerType === "pen";
        // iOS WebKit: Voice Control uses mouse-like events; readOnly toggle helps keyboard.
        // Real finger taps must skip it — otherwise the software keyboard often stays hidden.
        if (isLikelyIOS && !isTouchLike) {
            el.readOnly = true;
            el.focus({ preventScroll: true });
            el.readOnly = false;
        } else {
            el.focus({ preventScroll: true });
        }
        el.select();
    }, [recordingName]);

    const handleRecordingNameInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            valueTextAreaSet(e.target.value);
        },
        [],
    );

    const handleEditTouchStart = useCallback(() => {
        editActivationPointerTypeRef.current = "touch";
    }, []);

    const handleEditPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === "touch" || e.pointerType === "pen") {
            editActivationPointerTypeRef.current = e.pointerType;
            e.preventDefault();
        } else if (editActivationPointerTypeRef.current !== "touch") {
            editActivationPointerTypeRef.current = e.pointerType;
        }
    }, []);

    const handleTogglePin = useCallback(() => {
        if (isDisabled) return;
        onTogglePin(recordingName);
    }, [isDisabled, onTogglePin, recordingName]);

    const handleCancelEdit = useCallback(() => {
        isEditingRef.current = false;
        valueTextAreaSet(recordingName.slice(0, MAX_RECORDING_NAME_LENGTH));
        isEditingSet(false);
    }, [recordingName]);

    const handleSaveOrCancelPointerDownCapture = useCallback(() => {
        skipBlurDiscardRef.current = true;
    }, []);

    const handleRecordingNameInputBlur = useCallback(
        (e: React.FocusEvent<HTMLInputElement>) => {
            if (!isEditing) return;
            const next = e.relatedTarget;
            if (
                next instanceof HTMLElement &&
                (next.closest('.button-recording-save') ||
                    next.closest('.button-recording-cancel'))
            ) {
                return;
            }
            if (skipBlurDiscardRef.current) {
                skipBlurDiscardRef.current = false;
                return;
            }
            // Defer so a pending Save/Cancel click can run first (iOS omits relatedTarget).
            queueMicrotask(() => {
                if (skipBlurDiscardRef.current) {
                    skipBlurDiscardRef.current = false;
                    return;
                }
                if (!isEditingRef.current) return;
                const active = document.activeElement;
                if (
                    active instanceof HTMLElement &&
                    (active.closest('.button-recording-save') ||
                        active.closest('.button-recording-cancel'))
                ) {
                    return;
                }
                handleCancelEdit();
            });
        },
        [isEditing, handleCancelEdit],
    );

    return (
        <div
            className="recording-item"
            key={recordingName}
        >

            {/************************
                   Recording Name
            **************************/}
            <Flex gap={10} flex={1} align="center">
                <button
                    type="button"
                    onClick={handlePlay}
                    className="button-playback"
                    disabled={isDisabled}
                >
                    <PlayArrow htmlColor="hsl(204, 89%, 32%)" />
                </button>
                <Flex direction="column" flex={1}>
                    <input
                        ref={refRecordingNameInput}
                        type="text"
                        className="recording-name-input"
                        value={isEditing ? valueTextArea : recordingName} maxLength={MAX_RECORDING_NAME_LENGTH}
                        onChange={handleRecordingNameInputChange}
                        disabled={!isEditing}
                        onBlur={handleRecordingNameInputBlur}
                        aria-invalid={isRecordingNameDuplicate}
                        aria-describedby={recordingNameInputDescribedBy}
                    />
                    <HelperText
                        show={isRecordingNameDuplicate || isRecordingNameAtMaxLength}
                        variant={isRecordingNameDuplicate ? 'error' : 'warning'}
                        fontSize={13}
                    >
                        {isRecordingNameDuplicate ? 'Name already exists' : `Use ${MAX_RECORDING_NAME_LENGTH} characters or less`}
                    </HelperText>
                </Flex>
            </Flex>

            {/************************
                     3 Buttons
            **************************/}
            <Flex gap={!isEditing ? 20 : 5} className="recording-item-buttons">

                {/************************
                 Pin / Edit / Delete — or Save / Cancel while editing
                **************************/}
                {isEditing ? (
                    <>
                        <button
                            type="button"
                            onPointerDownCapture={handleSaveOrCancelPointerDownCapture}
                            onClick={updateRecordingName}
                            className="button-recording-save btn btn-tertiary"
                            disabled={isRecordingNameDuplicate}
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onPointerDownCapture={handleSaveOrCancelPointerDownCapture}
                            onClick={handleCancelEdit}
                            className="button-recording-cancel btn btn-tertiary"
                        >
                            Cancel
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            onPointerDown={handleTogglePin}
                            className="button-pin visible"
                            disabled={isDisabled}
                            aria-label={isPinned ? "Unpin recording" : "Pin recording"}
                            aria-pressed={isPinned}
                        >
                            {
                                isPinned
                                    ? <PushPinIcon fontSize="small" />
                                    : <PushPinOutlinedIcon fontSize="small" />}
                        </button>
                        <button
                            type="button"
                            onTouchStart={handleEditTouchStart}
                            onPointerDown={handleEditPointerDown}
                            onClick={handleEditClick}
                            className="button-edit visible"
                            disabled={isRecordingPlaying}
                        >
                            <EditIcon className="button-edit-icon" fontSize="small" />
                        </button>
                        <button
                            type="button"
                            onPointerDown={() => {
                                if (!isRecordingPlaying) {
                                    onRequestDeleteConfirm({ recordingName, idxFixed });
                                }
                            }}
                            className="button-delete"
                            disabled={isRecordingPlaying}
                        >
                            <DeleteIcon
                                className="button-delete-icon"
                                fontSize="small"
                            />
                        </button>
                    </>
                )}
            </Flex>
        </div >
    );
};

export default RecordingItem;
