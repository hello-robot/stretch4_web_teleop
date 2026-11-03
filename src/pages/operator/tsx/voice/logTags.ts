/**
 * Console tags for the voice assistant.
 *
 * A leaf module with no other imports, so the mic-health logger can be reached
 * without pulling in the OpenAI tool schemas that voice/constants re-exports.
 */

/** Console tag shared by VoiceCommandAssistant logs and mic-health status lines. */
export const VOICE_ASSISTANT_LOG_TAG = "VoiceCommandAssistant";
/** e.g. `[VoiceCommandAssistant]` — general voice assistant console prefix. */
export const VOICE_ASSISTANT_LOG_SLUG = `[${VOICE_ASSISTANT_LOG_TAG}]`;
/** e.g. `[VoiceCommandAssistant microphone health status]` — mic privilege/capture/mute. */
export const MIC_HEALTH_STATUS_SLUG = `[${VOICE_ASSISTANT_LOG_TAG} microphone health status]`;
