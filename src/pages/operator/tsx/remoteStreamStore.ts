/**
 * External store for camera track replacement.
 *
 * allRemoteStreams in index.tsx is mutated in place, so React props do not
 * change when a camera track is replaced. SimpleCameraView subscribes here
 * and uses the revision to set video.srcObject and call play() again.
 */
type RemoteStreamListener = () => void;

let revision = 0;
const listeners = new Set<RemoteStreamListener>();

/** Bump the revision and wake subscribers. Called for overhead and gripper replacements. */
export function notifyRemoteStreams(): void {
    revision += 1;
    listeners.forEach((listener) => listener());
}

/** Snapshot passed to useSyncExternalStore. */
export function remoteStreamRevision(): number {
    return revision;
}

/** Subscribe function passed to useSyncExternalStore. */
export function subscribeRemoteStreams(
    listener: RemoteStreamListener,
): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
