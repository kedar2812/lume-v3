/**
 * The browser-safe part of @lume/core: pure logic with no Node built-ins (no crypto, no filesystem),
 * so the web app can run the very same permission checks and step lists as the API. Anything that
 * needs node:crypto or the disk (tokens, TOTP, the breach list, Argon2) stays on the root export or
 * its own subpath, and apps/web's lint config forbids importing those.
 */
export * from "./rbac/catalog";
export * from "./rbac/engine";
export * from "./rbac/defaults";
export * from "./leads/phone";
export * from "./money/currencies";
export * from "./legal/documents";
export * from "./leads/mask";
export * from "./leads/custom-fields";
export * from "./leads/field-access";
export * from "./leads/presets";
export * from "./leads/contact-access";
export * from "./users/preferences";
export * from "./onboarding/steps";
export * from "./tour/steps";
export { INTAKE_LIMITS } from "./intake/limits";
// The intake engine's shapes, for the Import screens: types only (erased at build), so the engine itself
// — Papa Parse included — never reaches the browser.
export type { Delimiter, Encoding, FileWarning } from "./intake/read";
export type { DateOrder } from "./intake/values";
export type { ColumnMap, IntakeField, Issue, Mapping, OwnerRule, Rules, Transform } from "./intake/mapping";
export type { ColumnAnalysis } from "./intake/map-row";
export * from "./tasks/time";
export * from "./tasks/rules";
export * from "./messaging/render";
// The licence as people see it (no crypto: safe for the browser).
export * from "./licence/state";
