/**
 * Build-time feature flags.
 *
 * webpack's DefinePlugin substitutes each value from features.json (see
 * feature-flags.js), so a disabled feature's guards are boolean literals in
 * the bundle rather than a runtime lookup.
 */

/**
 * Speech voice control. Off unless features.json or
 * FEATURE_VOICE_CONTROL_INTERFACE enables it.
 */
export const FEATURE_VOICE_CONTROL_INTERFACE: boolean = Boolean(
    process.env.FEATURE_VOICE_CONTROL_INTERFACE,
);
