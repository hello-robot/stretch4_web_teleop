/**
 * Enums and types for Movement Recorder functions and constraints.
 */

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
