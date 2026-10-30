import React from "react";
import { CameraInfo, SignallingMessage, WebRTCMessage } from "shared/util";
import { safelyParseJSON, waitUntil } from "shared/util";
import { BaseSignaling } from "shared/signaling/Signaling";
import { createSignaler } from "shared/signaling/get_signaler";
import {
    RENEGOTIATE_CAMERA_INFO_KEY,
    createRenegotiationRequest,
    createSingleFlight,
    renegotiationNonce,
    shouldResetRobotPeer,
} from "./webrtcRecovery";

const peerConstraints = {
    iceServers: [
        {
            urls: "stun:stun1.l.google.com:19302",
        },
    ],
};

interface WebRTCProps {
    peerRole: "operator" | "robot";
    polite: boolean;
    onTrackAdded?: (ev: RTCTrackEvent) => void;
    onMessage: (message: WebRTCMessage) => void;
    onRobotConnectionStart?: () => void;
    onMessageChannelOpen?: () => void;
    onOperatorDisplaced?: () => void;
}

export class WebRTCConnection extends React.Component {
    private signaler: BaseSignaling;
    private peerConnection?: RTCPeerConnection;
    private peerRole: string;
    private polite: boolean;
    private makingOffer = false;
    private ignoreOffer: boolean = false;
    private isSettingRemoteAnswerPending = false;
    private pendingIceCandidates: (RTCIceCandidate | null)[];
    private dataChannelReceivedByteCount: number = 0;
    private dataChannelReceivedTimestamp: number = 0;
    private dataChannelConnectionState: boolean = false;
    private peerGeneration = 0;
    private runRecovery = createSingleFlight();
    private expectedRenegotiationNonce?: string;
    private robotRenegotiationNonce?: string;
    public robotAvailable = false;

    cameraInfo: CameraInfo = {};

    private messageChannel?: RTCDataChannel;

    private onTrackAdded?: (ev: RTCTrackEvent) => void;
    private onMessage: (obj: WebRTCMessage) => void;
    private onMessageChannelOpen?: () => void;
    private onRobotConnectionStart?: () => void;

    constructor(props: WebRTCProps) {
        super(props);
        this.peerRole = props.peerRole;
        this.polite = props.polite;
        this.onMessage = props.onMessage;
        this.onTrackAdded = props.onTrackAdded;
        this.onMessageChannelOpen = props.onMessageChannelOpen;
        this.onRobotConnectionStart = props.onRobotConnectionStart;
        this.pendingIceCandidates = [];

        this.createPeerConnection();

        this.onSignal = this.onSignal.bind(this);
        this.stop = this.stop.bind(this);
        this.signaler = createSignaler({
            onSignal: this.onSignal,
            onGoodbye: this.stop,
            onOperatorDisplaced: props.onOperatorDisplaced,
            onRobotConnectionStart: () => this.startRobotSession(),
            role: props.peerRole,
        });
    }

    configure_signaler(room_name: string) {
        return this.signaler.configure(room_name);
    }

    /**
     * Called to create bidirectional message channels with the connected peer.
     * Note that the peer is expected to be using this class to manage their end of the connection as well,
     * in which case the necessary event handlers will be installed in `createPeerConnection` during `ondatachannel`.
     */
    openDataChannels() {
        console.log("opened data channels");
        if (!this.peerConnection) throw "peerConnection undefined";
        const channel = this.peerConnection.createDataChannel("messages");
        this.setMessageChannel(channel);
    }

    private setMessageChannel(channel: RTCDataChannel) {
        this.messageChannel = channel;
        channel.onmessage = this.onReceiveMessageCallback.bind(this);
        const onDataChannelStateChange = () => {
            if (this.messageChannel !== channel) return;
            console.log("Data channel state is: " + channel.readyState);
            this.dataChannelConnectionState = channel.readyState === "open";
            if (channel.readyState === "open") {
                this.expectedRenegotiationNonce = undefined;
                this.onMessageChannelOpen?.();
            }
        };
        channel.onopen = onDataChannelStateChange;
        channel.onclose = onDataChannelStateChange;
    }

    private createPeerConnection() {
        try {
            this.makingOffer = false;
            this.ignoreOffer = false;
            this.isSettingRemoteAnswerPending = false;
            this.pendingIceCandidates = [];
            this.dataChannelReceivedByteCount = 0;
            this.dataChannelReceivedTimestamp = 0;
            this.dataChannelConnectionState = false;
            const generation = ++this.peerGeneration;
            const pc = new RTCPeerConnection(peerConstraints);
            this.peerConnection = pc;

            pc.onicecandidate = (event) => {
                if (pc !== this.peerConnection) return;
                console.log("ICE candidate available");
                this.signaler.send({
                    candidate: event.candidate!,
                });
            };

            pc.ontrack = (event) => {
                if (pc === this.peerConnection) this.onTrackAdded?.(event);
            };

            pc.ondatachannel = (event) => {
                if (pc !== this.peerConnection) return;
                // The remote has opened a data channel. We'll set up different handlers for the different channels.
                if (event.channel.label === "messages") {
                    this.setMessageChannel(event.channel);
                } else {
                    console.error(
                        "Unknown channel opened:",
                        event.channel.label,
                    );
                }
            };

            pc.onnegotiationneeded = async () => {
                console.log("Negotiation needed");
                if (pc !== this.peerConnection) return;
                try {
                    this.makingOffer = true;
                    await pc.setLocalDescription();
                    if (
                        pc === this.peerConnection &&
                        pc.localDescription
                    ) {
                        const cameraInfo = { ...this.cameraInfo };
                        if (this.robotRenegotiationNonce) {
                            cameraInfo[RENEGOTIATE_CAMERA_INFO_KEY] =
                                this.robotRenegotiationNonce;
                        }
                        this.signaler.send({
                            sessionDescription: pc.localDescription,
                            cameraInfo,
                        });
                    }
                } catch (err) {
                    if (pc === this.peerConnection) console.error(err);
                } finally {
                    if (generation === this.peerGeneration) {
                        this.makingOffer = false;
                    }
                }
            };

            pc.oniceconnectionstatechange = () => {
                if (pc !== this.peerConnection) return;
                if (pc.iceConnectionState === "failed") {
                    pc.restartIce();
                }
            };

            pc.onconnectionstatechange = () => {
                if (pc !== this.peerConnection) return;
                console.log(pc.connectionState);
                if (pc.connectionState !== "failed") return;
                if (this.peerRole === "operator") {
                    void this.recover();
                } else {
                    this.startRobotSession();
                }
            };

            pc.onicecandidateerror = (event) => {
                if (pc !== this.peerConnection) return;
                console.error(
                    "ICE candidate gathering error:",
                    event.errorCode,
                    " ",
                    event.errorText,
                );
            };

            console.log("Created RTCPeerConnection");
        } catch (e: any) {
            console.error(
                "Failed to create PeerConnection, exception: " + e.message,
            );
            return;
        }
    }

    connectionState() {
        return this.peerConnection?.connectionState;
    }

    /**
     * Starts a robot-side session on a clean peer. Repeated Firebase `active`
     * and explicit renegotiation events replace, rather than stack, channels.
     */
    private startRobotSession() {
        if (this.peerRole !== "robot") return;
        const pc = this.peerConnection;
        if (
            shouldResetRobotPeer({
                connectionState: pc?.connectionState,
                senderCount: pc?.getSenders().length ?? 0,
                hasChannel: Boolean(this.messageChannel),
            })
        ) {
            this.stop();
        }
        this.cameraInfo = {};
        this.onRobotConnectionStart?.();
    }

    joinRobotRoom() {
        console.log("joining room as robot");
        return this.signaler.join_as_robot();
    }

    addOperatorToRobotRoom() {
        console.log("joining room as operator");
        return this.signaler.join_as_operator();
    }

    operatorJoinBlocked() {
        return this.signaler.operatorJoinBlocked();
    }

    operatorJoinBlock() {
        return this.signaler.operatorJoinBlock();
    }

    requestOperatorTakeover() {
        this.signaler.requestOperatorTakeover();
    }

    addTrack(track: MediaStreamTrack, stream: MediaStream, streamName: string) {
        this.cameraInfo[stream.id] = streamName;
        if (!this.peerConnection) throw "pc is undefined";
        this.peerConnection.addTrack(track, stream);
        console.log("added track");
    }

    hangup() {
        // Tell the other end that we're ending the call so they can stop, and get us kicked out of the robot room
        console.warn("Hanging up");
        this.signaler.leave();
        if (!this.peerConnection) throw "pc is undefined";
        if (this.peerConnection.connectionState === "new") {
            // Don't reset PCs that don't have any state to reset
            return;
        }
        console.log("Hanging up.");
        this.stop();
    }

    stop() {
        if (!this.peerConnection) throw "peerConnection is undefined";
        console.log("Session terminated.");
        this.removeTracks();
        const oldPeerConnection = this.peerConnection;
        this.messageChannel = undefined;
        this.dataChannelConnectionState = false;
        oldPeerConnection.close();
        this.createPeerConnection();
    }

    /**
     * True only when the data channel and ICE path are both usable. WebKit may
     * leave the aggregate connectionState stale after returning to foreground.
     */
    isLinkUp(): boolean {
        const pc = this.peerConnection;
        const iceUp =
            pc?.iceConnectionState === "connected" ||
            pc?.iceConnectionState === "completed";
        return Boolean(
            pc &&
                pc.connectionState !== "closed" &&
                iceUp &&
                this.messageChannel?.readyState === "open",
        );
    }

    /**
     * Reclaims this page's existing signaling session, replaces its local peer,
     * and asks the robot for a fresh offer.
     */
    recover(): Promise<boolean> {
        if (this.peerRole !== "operator") return Promise.resolve(false);
        if (this.isLinkUp()) return Promise.resolve(true);
        return this.runRecovery(() => this.rebuildOperatorLink());
    }

    private async rebuildOperatorLink(): Promise<boolean> {
        const request = createRenegotiationRequest();
        const nonce = request.nonce;
        this.expectedRenegotiationNonce = nonce;
        this.stop();

        const joined = await Promise.race([
            this.addOperatorToRobotRoom(),
            new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), 8000),
            ),
        ]);
        if (!joined) {
            this.expectedRenegotiationNonce = undefined;
            return false;
        }

        this.signaler.send({ cameraInfo: request.cameraInfo });
        return Boolean(await waitUntil(() => this.isLinkUp(), 12000));
    }

    removeTracks() {
        if (!this.peerConnection) throw "peerConnection is undefined";
        const senders = this.peerConnection.getSenders();
        senders.forEach((sender) => this.peerConnection?.removeTrack(sender));
    }

    async onSignal(message: SignallingMessage) {
        let { candidate, sessionDescription, cameraInfo } = message;
        console.log("Received message:", message);
        const requestedRenegotiationNonce = renegotiationNonce(cameraInfo);
        if (
            this.peerRole === "robot" &&
            requestedRenegotiationNonce &&
            !sessionDescription &&
            candidate === undefined
        ) {
            this.robotRenegotiationNonce = requestedRenegotiationNonce;
            this.startRobotSession();
            return;
        }
        if (
            this.peerRole === "operator" &&
            sessionDescription?.type === "offer" &&
            this.expectedRenegotiationNonce &&
            requestedRenegotiationNonce !== this.expectedRenegotiationNonce
        ) {
            console.warn("Ignoring stale renegotiation offer");
            return;
        }
        if (cameraInfo) {
            const streamCameraInfo = { ...cameraInfo };
            delete streamCameraInfo[RENEGOTIATE_CAMERA_INFO_KEY];
            if (Object.keys(streamCameraInfo).length === 0) {
                console.warn("Received a camera info mapping with no entries");
            } else {
                this.cameraInfo = streamCameraInfo;
            }
        }
        if (
            sessionDescription?.type === "offer" ||
            sessionDescription?.type === "answer"
        ) {
            const pc = this.peerConnection;
            if (!pc) throw "peerConnection is undefined";
            const readyForOffer =
                !this.makingOffer &&
                (pc.signalingState === "stable" ||
                    this.isSettingRemoteAnswerPending);
            const offerCollision =
                sessionDescription.type === "offer" && !readyForOffer;

            this.ignoreOffer = !this.polite && offerCollision;

            if (this.ignoreOffer) {
                console.error("Ignoring offer");
                return;
            }
            this.isSettingRemoteAnswerPending =
                sessionDescription.type === "answer";
            try {
                await pc.setRemoteDescription(sessionDescription);
                if (pc !== this.peerConnection) return;
                this.isSettingRemoteAnswerPending = false;
                for (const queuedCandidate of this.pendingIceCandidates) {
                    try {
                        await pc.addIceCandidate(queuedCandidate);
                    } catch (err) {
                        console.warn("Ignoring stale ICE candidate", err);
                    }
                }
                this.pendingIceCandidates = [];
                if (sessionDescription.type === "offer") {
                    await pc.setLocalDescription();
                    if (pc !== this.peerConnection || !pc.localDescription) {
                        return;
                    }
                    this.signaler.send({
                        sessionDescription: pc.localDescription,
                    });
                }
            } catch (err) {
                if (pc === this.peerConnection) {
                    this.isSettingRemoteAnswerPending = false;
                    console.error("Failed to apply session description", err);
                }
            }
        } else if (candidate !== undefined && this.peerConnection) {
            if (!this.peerConnection.remoteDescription) {
                this.pendingIceCandidates.push(candidate);
                return;
            }
            try {
                await this.peerConnection.addIceCandidate(candidate);
            } catch (e: any) {
                if (!this.ignoreOffer) {
                    console.log("Failure during addIceCandidate(): " + e.name);
                }
            }
        } else {
            console.error("Unable to handle message");
        }
    }

    ////////////////////////////////////////////////////////////
    // RTCDataChannel
    // on Sept. 15, 2017 copied initial code from
    // https://github.com/googlecodelabs/webrtc-web/blob/master/step-03/js/main.js
    // initial code licensed with Apache License 2.0
    ////////////////////////////////////////////////////////////

    sendData(obj: WebRTCMessage | WebRTCMessage[]) {
        if (!this.messageChannel || this.messageChannel.readyState !== "open") {
            // console.warn("Trying to send data, but data channel isn't ready")
            return;
        }
        const data = JSON.stringify(obj);
        this.messageChannel.send(data);
    }

    onReceiveMessageCallback(event: { data: string }) {
        const obj: WebRTCMessage | WebRTCMessage[] = safelyParseJSON(
            event.data,
        );
        if (this.onMessage) this.onMessage(obj);
    }

    /**
     * Returns whether the data channel is connected. This function implements two
     * ways of doing so:
     * 1. It requests a data report from the peer connection and checks the number
     *   of bytes received.
     * 2. It checks the connection state of the peer connection.
     * @param report if True, use option 1 above. Otherwise, use option 2.
     * @returns whether the data channel is connected
     */
    async isConnected(report: boolean = false) {
        if (report) {
            await this.peerConnection?.getStats(null).then((stats) => {
                stats.forEach((report) => {
                    if (report.type == "data-channel") {
                        // Ignore repeated reports
                        if (
                            report.timestamp <=
                            this.dataChannelReceivedTimestamp
                        )
                            return this.dataChannelConnectionState;

                        // console.log(
                        //   "Data channel report: bytes sent", report.bytesSent,
                        //   ", bytes received", report.bytesReceived,
                        //   ", messages sent", report.messagesSent,
                        //   ", messages received", report.messagesReceived,
                        //   ", state", report.state,
                        // )

                        // bytesReceived contains the total number of bytes received over the
                        // lifetime of the data channel. If it has increased since the last report,
                        // then the data channel is still connected.
                        this.dataChannelConnectionState =
                            report.bytesReceived >
                            this.dataChannelReceivedByteCount;
                        this.dataChannelReceivedByteCount =
                            report.bytesReceived;
                        this.dataChannelReceivedTimestamp = report.timestamp;
                    }
                });
            });
        } else {
            this.dataChannelConnectionState = this.isLinkUp();
        }
        return this.dataChannelConnectionState;
    }
}
