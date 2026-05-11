import { StorageHandler } from "./StorageHandler";
import { LayoutDefinition } from "../utils/component_definitions";
import { RobotPose } from "shared/util";
import ROSLIB from "roslib";

/** One row in `user_pose_recording_names` (localStorage JSON array). */
export type RecordingListEntry = {
    recording: string;
    isPinned: boolean,
};

/** Uses browser local storage to store data. */
export class LocalStorageHandler extends StorageHandler {
    public static CURRENT_LAYOUT_KEY = "user_custom_layout";
    public static LAYOUT_NAMES_KEY = "user_custom_layout_names";
    public static POSE_NAMES_KEY = "user_pose_names";
    public static MAP_POSE_NAMES_KEY = "user_map_pose_names";
    public static MAP_POSE_TYPES_KEY = "user_map_pose_types";
    public static POSE_RECORDING_NAMES_KEY = "user_pose_recording_names";

    constructor(onStorageHandlerReadyCallback: () => void) {
        super(onStorageHandlerReadyCallback);
        // Allow the initialization process to complete before invoking the callback
        setTimeout(() => {
            this.getCustomLayoutNames();
            this.onReadyCallback();
        }, 0);
    }

    public loadCustomLayout(layoutName: string): LayoutDefinition {
        const storedJson = localStorage.getItem(layoutName);
        if (!storedJson)
            throw Error(`Could not load custom layout ${layoutName}`);
        return JSON.parse(storedJson);
    }

    public saveCustomLayout(
        layout: LayoutDefinition,
        layoutName: string
    ): void {
        const layoutNames = this.getCustomLayoutNames();
        layoutNames.push(layoutName);
        localStorage.setItem(
            LocalStorageHandler.LAYOUT_NAMES_KEY,
            JSON.stringify(layoutNames)
        );
        localStorage.setItem(layoutName, JSON.stringify(layout));
    }

    public saveCurrentLayout(layout: LayoutDefinition): void {
        localStorage.setItem(
            LocalStorageHandler.CURRENT_LAYOUT_KEY,
            JSON.stringify(layout)
        );
    }

    public loadCurrentLayout(): LayoutDefinition | null {
        const storedJson = localStorage.getItem(
            LocalStorageHandler.CURRENT_LAYOUT_KEY
        );
        if (!storedJson) return null;
        return JSON.parse(storedJson);
    }

    public getCustomLayoutNames(): string[] {
        const storedJson = localStorage.getItem(
            LocalStorageHandler.LAYOUT_NAMES_KEY
        );
        if (!storedJson) return [];
        return JSON.parse(storedJson);
    }

    public saveMapPose(
        poseName: string,
        pose: ROSLIB.Transform,
        poseType: string
    ) {
        const poseNames = this.getMapPoseNames();
        const poseTypes = this.getMapPoseTypes();
        // If pose name does not exist add the name, type and pose, otherwise replace the
        // type and pose for the given name
        if (!poseNames.includes(poseName)) {
            poseNames.push(poseName);
            poseTypes.push(poseType);
        } else {
            let idx = poseNames.indexOf(poseName);
            poseTypes[idx] = poseType;
        }
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_NAMES_KEY,
            JSON.stringify(poseNames)
        );
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_TYPES_KEY,
            JSON.stringify(poseTypes)
        );
        localStorage.setItem("map_" + poseName, JSON.stringify(pose));
    }

    public getMapPoseNames(): string[] {
        const storedJson = localStorage.getItem(
            LocalStorageHandler.MAP_POSE_NAMES_KEY
        );
        if (!storedJson) return [];
        return JSON.parse(storedJson);
    }

    public getMapPose(poseName: string): ROSLIB.Transform {
        const storedJson = localStorage.getItem(`map_${poseName}`);
        if (!storedJson) throw new Error(`Could not load pose ${poseName}`);
        return JSON.parse(storedJson) as ROSLIB.Transform;
    }

    public getMapPoses(): ROSLIB.Transform[] {
        const poseNames = this.getMapPoseNames();
        var poses: ROSLIB.Transform[] = [];
        poseNames.forEach((poseName) => {
            const pose = this.getMapPose(poseName);
            poses.push(pose);
        });
        return poses;
    }

    public getMapPoseTypes(): string[] {
        const storedJson = localStorage.getItem(
            LocalStorageHandler.MAP_POSE_TYPES_KEY
        );
        if (!storedJson) return [];
        return JSON.parse(storedJson);
    }

    public deleteMapPose(poseName: string): void {
        const poseNames = this.getMapPoseNames();
        if (!poseNames.includes(poseName)) return;
        localStorage.removeItem("map_" + poseName);
        const index = poseNames.indexOf(poseName);
        poseNames.splice(index, 1);
        const poseTypes = this.getMapPoseTypes();
        poseTypes.splice(index, 1);
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_NAMES_KEY,
            JSON.stringify(poseNames)
        );
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_TYPES_KEY,
            JSON.stringify(poseTypes)
        );
    }

    /**
     * Renames a map pose from
     * "poseNameOld" to "poseNameNew"
     */
    public renamePose(poseNameOld: string, poseNameNew: string): void {
        if (poseNameOld === poseNameNew) return;
        let poseNames = this.getMapPoseNames();
        let poseTypes = this.getMapPoseTypes();
        const idx = poseNames.indexOf(poseNameOld);
        if (idx === -1) return;
        // Get pose and type
        const pose = this.getMapPose(poseNameOld);
        const type = poseTypes[idx];
        // Remove old pose from storage
        localStorage.removeItem("map_" + poseNameOld);
        // Replace name and keep position
        poseNames[idx] = poseNameNew;
        poseTypes[idx] = type;
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_NAMES_KEY,
            JSON.stringify(poseNames)
        );
        localStorage.setItem(
            LocalStorageHandler.MAP_POSE_TYPES_KEY,
            JSON.stringify(poseTypes)
        );
        localStorage.setItem("map_" + poseNameNew, JSON.stringify(pose));
    }

    private readRecordingEntries(): RecordingListEntry[] {
        const storedJson = localStorage.getItem(
            LocalStorageHandler.POSE_RECORDING_NAMES_KEY,
        );
        if (!storedJson) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(storedJson);
        } catch {
            return [];
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return [];

        if (typeof parsed[0] === "string") {
            const migrated: RecordingListEntry[] = (parsed as string[]).map(
                (recording) => ({
                    recording,
                    isPinned: false,
                }),
            );
            this.writeRecordingEntries(migrated);
            return migrated;
        }

        const entries: RecordingListEntry[] = [];
        for (const item of parsed) {
            if (
                item
                && typeof item === "object"
                && "recording" in item
                && typeof (item as RecordingListEntry).recording === "string"
            ) {
                const r = item as RecordingListEntry;
                entries.push({
                    recording: r.recording,
                    isPinned: r.isPinned === true,
                });
            }
        }

        return entries;
    }

    private writeRecordingEntries(entries: RecordingListEntry[]): void {
        localStorage.setItem(
            LocalStorageHandler.POSE_RECORDING_NAMES_KEY,
            JSON.stringify(entries),
        );
    }

    public getRecordingNames(): string[] {
        return this.readRecordingEntries().map((e) => e.recording);
    }

    public getRecording(recordingName: string): RobotPose[] {
        const storedJson = localStorage.getItem("recording_" + recordingName);
        if (!storedJson)
            throw Error(`Could not load recording ${recordingName}`);
        return JSON.parse(storedJson);
    }

    public savePoseRecording(recordingName: string, poses: RobotPose[]): void {
        const entries = this.readRecordingEntries();
        if (!entries.some((e) => e.recording === recordingName)) {
            entries.unshift({
                recording: recordingName,
                isPinned: false,
            });
        }
        this.writeRecordingEntries(entries);
        localStorage.setItem(
            "recording_" + recordingName,
            JSON.stringify(poses),
        );
    }

    public deleteRecording(recordingName: string): void {
        const entries = this.readRecordingEntries();
        if (!entries.some((e) => e.recording === recordingName)) return;
        localStorage.removeItem("recording_" + recordingName);
        const next = entries.filter((e) => e.recording !== recordingName);
        this.writeRecordingEntries(next);
    }

    public getPinnedRecordingNames(): string[] {
        const valid = new Set(this.getRecordingNames());
        const names = this.readRecordingEntries()
            .filter(
                (e) => e.isPinned && valid.has(e.recording),
            )
            .map((e) => e.recording);
        return names.sort((a, b) => a.localeCompare(b));
    }

    public setPinnedRecordingNames(names: string[]): void {
        const valid = new Set(this.getRecordingNames());
        const pinnedSet = new Set(
            names.filter((n) => typeof n === "string" && valid.has(n)),
        );
        const entries = this.readRecordingEntries();
        for (const e of entries) {
            e.isPinned = pinnedSet.has(e.recording);
        }
        this.writeRecordingEntries(entries);
    }

    public renamePinnedRecording(oldName: string, newName: string): void {
        if (oldName === newName) return;
        const entries = this.readRecordingEntries();
        const e = entries.find((x) => x.recording === oldName);
        if (e) {
            e.recording = newName;
            this.writeRecordingEntries(entries);
        }
    }
}
