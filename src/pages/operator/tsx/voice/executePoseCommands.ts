/**
 * Voice tool execution handlers for saved pose macros:
 * - set_saved_poses_modal (open / close saved poses modal)
 * - save_pose (stop motion, start record, capture 1 pose snapshot, save as name)
 * - move_to_pose (match saved pose name via matchSavedLocation and play back)
 * - edit_pose (rename saved pose or prompt edit UI)
 * - delete_pose (delete a saved pose by name)
 * - pin_pose (pin or unpin a saved pose by name)
 */

import { FunctionProvider } from "../function_providers/FunctionProvider";
import { movementRecorderFunctionProvider } from "../index";
import { MovementRecorderFunction } from "../function_providers/MovementRecorderTypes";
import { matchSavedLocation } from "./matchSavedLocation";
import {
    DeletePoseResult,
    EditPoseResult,
    MoveToPoseResult,
    PinPoseAction,
    PinPoseResult,
    SavedPosesModalAction,
    SavePoseResult,
    SetSavedPosesModalResult,
} from "./constants";
import { RealtimeVoiceFunctionsProvider } from "./voiceFunctionsProvider";

/**
 * Helper to safely parse raw tool arguments (which can be a JSON string or an object).
 */
function parseArgsObject(rawArgs: unknown): Record<string, unknown> {
    if (typeof rawArgs === "string") {
        try {
            const parsed = JSON.parse(rawArgs || "{}");
            if (typeof parsed === "object" && parsed !== null) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return {};
        }
    }
    if (typeof rawArgs === "object" && rawArgs !== null) {
        return rawArgs as Record<string, unknown>;
    }
    return {};
}

/**
 * Executes set_saved_poses_modal (opens or closes the Saved Poses / Movement Recorder modal).
 */
export function executeSetSavedPosesModal(
    rawArgs: unknown,
    onSetSavedPosesModal?: (
        action: SavedPosesModalAction,
    ) => SetSavedPosesModalResult,
): SetSavedPosesModalResult {
    const args = parseArgsObject(rawArgs);
    const action = args.action === "close" ? "close" : "open";

    if (!onSetSavedPosesModal) {
        return {
            ok: false,
            detail: "Saved Poses modal control is unavailable.",
        };
    }

    return onSetSavedPosesModal(action);
}

/**
 * Helper to sleep for a given number of milliseconds.
 */
function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes save_pose:
 * 1. Stops any ongoing robot motion.
 * 2. Starts movement recording with arm, lift, wrist joints enabled (gripper false).
 * 3. Takes an immediate pose snapshot into the recorder.
 * 4. Waits 50ms (strictly <= 0.1s max).
 * 5. Saves recording under the given name.
 */
export async function executeSavePose(
    rawArgs: unknown,
    voiceProvider?: RealtimeVoiceFunctionsProvider,
): Promise<SavePoseResult> {
    const args = parseArgsObject(rawArgs);
    const rawName = typeof args.name === "string" ? args.name.trim() : "";

    if (!rawName) {
        return {
            ok: false,
            detail: "Specify a pose name to save.",
        };
    }

    if (!FunctionProvider.robotIsConnected()) {
        return {
            ok: false,
            detail: "Robot is disconnected; cannot save pose.",
        };
    }

    // 1. Stop any ongoing robot motion first
    FunctionProvider.stopAllActions(true);
    FunctionProvider.remoteRobot?.stopTrajectory();

    const recordFn = movementRecorderFunctionProvider.provideFunctions(
        MovementRecorderFunction.Record,
    ) as (
        arm: boolean,
        lift: boolean,
        wrist_roll: boolean,
        wrist_pitch: boolean,
        wrist_yaw: boolean,
        gripper: boolean,
    ) => void;

    const saveRecordingFn = movementRecorderFunctionProvider.provideFunctions(
        MovementRecorderFunction.SaveRecording,
    ) as (name: string) => void;

    // 2. Break out joint parameters explicitly by name and set all to true except gripper
    const arm = true;
    const lift = true;
    const wrist_roll = true;
    const wrist_pitch = true;
    const wrist_yaw = true;
    const gripper = false;

    recordFn(arm, lift, wrist_roll, wrist_pitch, wrist_yaw, gripper);

    // 3. Immediately capture current pose snapshot into the recorder buffer
    if (FunctionProvider.remoteRobot) {
        const currentPose = FunctionProvider.remoteRobot.sensors.getRobotPose(
            arm,
            lift,
            wrist_roll,
            wrist_pitch,
            wrist_yaw,
            gripper,
        );
        movementRecorderFunctionProvider.pushPoseSnapshot(currentPose);
    }

    // TODO: remove the 50ms sleep
    await sleepMs(50);

    // 4. Save recording under the requested name
    saveRecordingFn(rawName);
    movementRecorderFunctionProvider.refreshRecordings();

    return {
        ok: true,
        detail: `Pose "${rawName}" saved.`,
        name: rawName,
    };
}

/**
 * Executes move_to_pose:
 * Matches target pose name against saved pose names using matchSavedLocation
 * and triggers trajectory playback.
 */
export function executeMoveToPose(rawArgs: unknown): MoveToPoseResult {
    const args = parseArgsObject(rawArgs);
    const rawName = typeof args.name === "string" ? args.name.trim() : "";

    if (!rawName) {
        return {
            ok: false,
            detail: "Specify a saved pose name to move to.",
        };
    }

    if (!FunctionProvider.robotIsConnected()) {
        return {
            ok: false,
            detail: "Robot is disconnected; cannot move to pose.",
        };
    }

    const savedRecordingNamesFn =
        movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SavedRecordingNames,
        ) as () => string[];

    const loadRecordingNameFn =
        movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.LoadRecordingName,
        ) as (name: string) => void;

    const savedNames = savedRecordingNamesFn();

    // Use the exact same matching scheme as navigation pose implementation
    const match = matchSavedLocation(rawName, savedNames);

    if (match.kind === "none") {
        return {
            ok: false,
            detail: `Unknown pose: "${rawName}".`,
        };
    }

    if (match.kind === "ambiguous") {
        return {
            ok: false,
            detail: `Multiple saved poses match "${rawName}". Please be more specific.`,
        };
    }

    const matchedName = match.name;
    const matchedIdx = savedNames.indexOf(matchedName);

    // Prepare UI state for playback: close modal, activate camera veil, set playing index
    movementRecorderFunctionProvider.setModalOpen(false);
    movementRecorderFunctionProvider.setCameraVeil(true);
    if (matchedIdx >= 0) {
        movementRecorderFunctionProvider.setIdxFixedRecordingPlaying(matchedIdx);
    }

    loadRecordingNameFn(matchedName);

    return {
        ok: true,
        detail: `Moving to pose "${matchedName}".`,
        name: matchedName,
    };
}

/**
 * Executes edit_pose:
 * Matches target pose name against saved pose names and renames the recording.
 *
 * Args:
 *     rawArgs: The raw tool call arguments (containing old_name and new_name).
 *
 * Returns:
 *     An EditPoseResult indicating success or failure.
 */
export function executeEditPose(
    rawArgs: unknown,
): EditPoseResult {
    const args = parseArgsObject(rawArgs);
    const rawOldName =
        typeof args.old_name === "string"
            ? args.old_name.trim()
            : typeof args.name === "string"
                ? args.name.trim()
                : "";
    const rawNewName =
        typeof args.new_name === "string" ? args.new_name.trim() : "";

    if (!rawOldName || !rawNewName) {
        return {
            ok: false,
            detail: "Specify both the current pose name and the new pose name (e.g. 'rename pose stow to parked').",
        };
    }

    const savedRecordingNamesFn =
        movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SavedRecordingNames,
        ) as () => string[];

    const savedNames = savedRecordingNamesFn();
    const match = matchSavedLocation(rawOldName, savedNames);

    if (match.kind === "none") {
        return {
            ok: false,
            detail: `Unknown pose: "${rawOldName}".`,
        };
    }

    if (match.kind === "ambiguous") {
        return {
            ok: false,
            detail: `Multiple saved poses match "${rawOldName}". Please be more specific.`,
        };
    }

    const matchedOldName = match.name;

    if (savedNames.includes(rawNewName) && rawNewName !== matchedOldName) {
        return {
            ok: false,
            detail: `A pose named "${rawNewName}" already exists.`,
        };
    }

    movementRecorderFunctionProvider.renameRecordingByName(
        matchedOldName,
        rawNewName,
    );

    return {
        ok: true,
        detail: `Renamed pose "${matchedOldName}" to "${rawNewName}".`,
        oldName: matchedOldName,
        newName: rawNewName,
    };
}

/**
 * Executes delete_pose:
 * Matches target pose name against saved pose names and deletes the recording.
 *
 * Args:
 *     rawArgs: The raw tool call arguments (containing name).
 *
 * Returns:
 *     A DeletePoseResult indicating success or failure.
 */
export function executeDeletePose(rawArgs: unknown): DeletePoseResult {
    const args = parseArgsObject(rawArgs);
    const rawName = typeof args.name === "string" ? args.name.trim() : "";

    if (!rawName) {
        return {
            ok: false,
            detail: "Specify a saved pose name to delete.",
        };
    }

    const savedRecordingNamesFn =
        movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SavedRecordingNames,
        ) as () => string[];

    const savedNames = savedRecordingNamesFn();
    const match = matchSavedLocation(rawName, savedNames);

    if (match.kind === "none") {
        return {
            ok: false,
            detail: `Unknown pose: "${rawName}".`,
        };
    }

    if (match.kind === "ambiguous") {
        return {
            ok: false,
            detail: `Multiple saved poses match "${rawName}". Please be more specific.`,
        };
    }

    const matchedName = match.name;
    movementRecorderFunctionProvider.deleteRecordingByName(matchedName);

    return {
        ok: true,
        detail: `Deleted pose "${matchedName}".`,
        name: matchedName,
    };
}

/**
 * Executes pin_pose:
 * Matches target pose name against saved pose names and pins or unpins the recording.
 *
 * Args:
 *     rawArgs: The raw tool call arguments (containing action and name).
 *
 * Returns:
 *     A PinPoseResult indicating success or failure.
 */
export function executePinPose(rawArgs: unknown): PinPoseResult {
    const args = parseArgsObject(rawArgs);
    const rawName = typeof args.name === "string" ? args.name.trim() : "";
    const action = args.action === "unpin" ? "unpin" : "pin";

    if (!rawName) {
        return {
            ok: false,
            detail: `Specify a saved pose name to ${action}.`,
        };
    }

    const savedRecordingNamesFn =
        movementRecorderFunctionProvider.provideFunctions(
            MovementRecorderFunction.SavedRecordingNames,
        ) as () => string[];

    const savedNames = savedRecordingNamesFn();
    const match = matchSavedLocation(rawName, savedNames);

    if (match.kind === "none") {
        return {
            ok: false,
            detail: `Unknown pose: "${rawName}".`,
        };
    }

    if (match.kind === "ambiguous") {
        return {
            ok: false,
            detail: `Multiple saved poses match "${rawName}". Please be more specific.`,
        };
    }

    const matchedName = match.name;
    const isPinned = action === "pin";
    movementRecorderFunctionProvider.pinRecording(matchedName, isPinned);

    return {
        ok: true,
        detail: isPinned
            ? `Pinned pose "${matchedName}".`
            : `Unpinned pose "${matchedName}".`,
        name: matchedName,
        action,
    };
}
