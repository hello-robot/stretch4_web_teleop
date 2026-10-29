import React from "react";

type AudioStreamProps = {};

/**
 * Manages audio capture from the robot microphone for WebRTC streaming.
 */
export class AudioStream extends React.Component<AudioStreamProps> {
    outputAudioStream?: MediaStream;

    /**
     * Initializes the AudioStream instance.
     *
     * Args:
     *     props: Properties for audio stream initialization.
     */
    constructor(props: AudioStreamProps) {
        super(props);
        this.outputAudioStream = new MediaStream();
    }

    /**
     * Starts audio capture using the system default microphone.
     *
     * Returns:
     *     Promise resolving once audio capture is initiated.
     */
    async start(): Promise<void> {
        try {
            this.outputAudioStream = await navigator.mediaDevices.getUserMedia({
                audio: true, // Will use the default system mic
                video: false,
            });
            console.log("AudioStream: Successfully acquired robot microphone stream");
        } catch (err) {
            console.error("AudioStream: Failed to acquire robot microphone stream:", err);
        }
    }
}
