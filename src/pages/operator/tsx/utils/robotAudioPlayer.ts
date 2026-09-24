/**
 * Manages Web Audio playback for the incoming robot audio stream.
 *
 * Implements a Web Audio pipeline using AudioContext and GainNode to stream
 * audio from the robot's microphone with gain control and autoplay resilience.
 */
export class RobotAudioPlayer {
    private static instance?: RobotAudioPlayer;
    private audioContext?: AudioContext;
    private gainNode?: GainNode;
    private sourceNode?: MediaStreamAudioSourceNode;
    private dummyAudioElement?: HTMLAudioElement;
    private isMuted: boolean = false;
    private currentGain: number = 1.0;
    private hasUserGestureListener: boolean = false;

    /**
     * Retrieves the singleton instance of RobotAudioPlayer.
     *
     * Returns:
     *     The singleton RobotAudioPlayer instance.
     */
    public static getInstance(): RobotAudioPlayer {
        if (!RobotAudioPlayer.instance) {
            RobotAudioPlayer.instance = new RobotAudioPlayer();
        }
        return RobotAudioPlayer.instance;
    }

    /**
     * Initializes the RobotAudioPlayer instance.
     */
    constructor() {
        this.setupUserGestureUnlock = this.setupUserGestureUnlock.bind(this);
    }

    /**
     * Sets up one-time user interaction listeners to resume the AudioContext
     * if blocked by browser autoplay policies.
     */
    private setupUserGestureUnlock(): void {
        if (this.hasUserGestureListener) {
            return;
        }
        this.hasUserGestureListener = true;

        const unlockAudio = () => {
            if (this.audioContext && this.audioContext.state === "suspended") {
                this.audioContext
                    .resume()
                    .then(() => {
                        console.log("RobotAudioPlayer: AudioContext resumed on user interaction");
                    })
                    .catch((err) => {
                        console.warn("RobotAudioPlayer: Error resuming AudioContext:", err);
                    });
            }
            if (this.dummyAudioElement && this.dummyAudioElement.paused) {
                this.dummyAudioElement.play().catch(() => {});
            }
            window.removeEventListener("click", unlockAudio);
            window.removeEventListener("keydown", unlockAudio);
            window.removeEventListener("pointerdown", unlockAudio);
            window.removeEventListener("touchstart", unlockAudio);
            this.hasUserGestureListener = false;
        };

        window.addEventListener("click", unlockAudio, { once: true });
        window.addEventListener("keydown", unlockAudio, { once: true });
        window.addEventListener("pointerdown", unlockAudio, { once: true });
        window.addEventListener("touchstart", unlockAudio, { once: true });
    }

    /**
     * Initializes the AudioContext and GainNode pipeline if not already created.
     */
    private ensureAudioContext(): void {
        if (!this.audioContext) {
            const AudioCtxClass =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            this.audioContext = new AudioCtxClass();
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.setValueAtTime(
                this.isMuted ? 0 : this.currentGain,
                this.audioContext.currentTime
            );
            this.gainNode.connect(this.audioContext.destination);
        }

        if (this.audioContext.state === "suspended") {
            this.audioContext.resume().catch(() => {
                this.setupUserGestureUnlock();
            });
        }
    }

    /**
     * Connects an incoming robot MediaStream to the audio output pipeline.
     *
     * Args:
     *     stream: The remote MediaStream containing the robot audio track.
     */
    public playStream(stream: MediaStream): void {
        const audioTracks = stream.getAudioTracks();
        console.log("RobotAudioPlayer: Received stream with", audioTracks.length, "audio tracks");
        if (audioTracks.length === 0) {
            console.warn("RobotAudioPlayer: Stream contains no audio tracks to play");
            return;
        }

        this.ensureAudioContext();

        // Disconnect existing source node if any
        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (err) {
                console.warn("RobotAudioPlayer: Error disconnecting previous sourceNode:", err);
            }
            this.sourceNode = undefined;
        }

        // Attach to a muted HTML5 audio element to ensure Chromium-based browser WebRTC decoders keep streaming
        if (!this.dummyAudioElement) {
            this.dummyAudioElement = document.createElement("audio");
            this.dummyAudioElement.muted = true;
            this.dummyAudioElement.autoplay = true;
        }
        this.dummyAudioElement.srcObject = stream;
        this.dummyAudioElement.play().catch(() => {
            // Autoplay may be deferred until user gesture; unlock handler covers this
        });

        try {
            if (this.audioContext && this.gainNode) {
                this.sourceNode = this.audioContext.createMediaStreamSource(stream);
                this.sourceNode.connect(this.gainNode);
                console.log(
                    `RobotAudioPlayer: Connected audio stream to Web Audio GainNode (gain=${this.currentGain}, muted=${this.isMuted})`
                );
            }
        } catch (err) {
            console.error("RobotAudioPlayer: Error connecting MediaStream to Web Audio API:", err);
        }

        if (this.audioContext && this.audioContext.state === "suspended") {
            this.setupUserGestureUnlock();
        }
    }

    /**
     * Sets the volume gain value for audio playback.
     *
     * Args:
     *     gain: Linear gain multiplier (e.g. 1.0 = unity gain, >1.0 = amplification boost).
     */
    public setGain(gain: number): void {
        this.currentGain = Math.max(0, gain);
        if (this.gainNode && this.audioContext && !this.isMuted) {
            this.gainNode.gain.setValueAtTime(this.currentGain, this.audioContext.currentTime);
        }
    }

    /**
     * Returns the current gain level.
     *
     * Returns:
     *     The current linear gain multiplier.
     */
    public getGain(): number {
        return this.currentGain;
    }

    /**
     * Sets the mute status of the audio stream.
     *
     * Args:
     *     muted: True to mute audio output, false to unmute.
     */
    public setMuted(muted: boolean): void {
        this.isMuted = muted;
        if (this.gainNode && this.audioContext) {
            this.gainNode.gain.setValueAtTime(
                this.isMuted ? 0 : this.currentGain,
                this.audioContext.currentTime
            );
        }
    }

    /**
     * Returns whether the audio playback is currently muted.
     *
     * Returns:
     *     True if muted, false otherwise.
     */
    public getMuted(): boolean {
        return this.isMuted;
    }

    /**
     * Stops and disconnects audio playback.
     */
    public stop(): void {
        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (err) {
                console.warn("RobotAudioPlayer: Error disconnecting sourceNode on stop:", err);
            }
            this.sourceNode = undefined;
        }
        if (this.dummyAudioElement) {
            this.dummyAudioElement.pause();
            this.dummyAudioElement.srcObject = null;
        }
    }
}
