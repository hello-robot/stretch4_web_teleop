/**
 * Microphone health log line, shared by the Realtime session and the voice
 * status store.
 *
 * Kept in its own leaf module so the status store — which FooterGlobal reads
 * on every render — does not pull in realtimeSession, and with it mic capture
 * and the OpenAI Realtime connection.
 */

import { MIC_HEALTH_STATUS_SLUG } from "./logTags";
import { emitMicEvent } from "./voiceInteractionEmitter";

export type MicHealthStatusEvent =
    | "User access granted"
    | "User access rejected"
    | "Connected"
    | "Disconnected"
    | "Muted"
    | "Unmuted";

export function logMicHealthStatus(event: MicHealthStatusEvent): void {
    console.log(`${MIC_HEALTH_STATUS_SLUG} ${event}`);
    emitMicEvent({ event });
}
