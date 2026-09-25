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
export * from "./leads/mask";
export * from "./leads/custom-fields";
export * from "./leads/field-access";
export * from "./leads/presets";
export * from "./leads/contact-access";
export * from "./users/preferences";
export * from "./onboarding/steps";
export * from "./tour/steps";
