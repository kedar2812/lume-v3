import type { Capabilities } from "@lume/core";

/**
 * Which integrations this build actually has. The onboarding Connect step and the tour's Calendar step
 * appear only when the matching one is true, so no screen ever offers something that isn't there.
 * Flipped to true by the phases that build them (Sheets intake, then Google Calendar connect).
 */
export const CAPABILITIES: Capabilities = { sheets: false, calendar: false };
