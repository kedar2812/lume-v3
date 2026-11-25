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
export * from "./users/device";
export * from "./users/avatar";
// Feedback from a client's LUME (spec 2026-10-16): the limits and checks the sheet and both servers share.
export * from "./feedback/rules";
export * from "./images/clean";
// Fleet (spec 2026-10-16 fleet): the health a LUME reports and the announcement claim, zod only.
export * from "./licence/fleet";
// Plan tiers (Plans and pricing, November 2026): what each tier switches on.
export * from "./licence/tiers";
export * from "./users/initials";
export * from "./analytics";
export * from "./onboarding/steps";
export * from "./tour/steps";
export { INTAKE_LIMITS } from "./intake/limits";
// The intake engine's shapes, for the Import screens: types only (erased at build), so the engine itself
// — Papa Parse included — never reaches the browser.
export type { Delimiter, Encoding, FileWarning } from "./intake/read";
export type { DateOrder } from "./intake/values";
export type { ColumnMap, IntakeField, Issue, Mapping, OwnerRule, Rules, Transform } from "./intake/mapping";
export type { ColumnAnalysis } from "./intake/map-row";
export type { ColumnProfile } from "./intake/profile";
export * from "./tasks/time";
export * from "./tasks/rules";
// Settings → Calendar's rules (5A): no I/O, safe for the browser.
export * from "./calendar/rules";
// Schedule a meeting (2026-11-13): the request and the WhatsApp message with its Meet link.
export * from "./calendar/schedule";
export * from "./messaging/render";
// WhatsApp's template rules and rate card (W3b-2): pure, so the editor checks a template as the server will.
export * from "./whatsapp/templates";
export * from "./whatsapp/rates";
export * from "./whatsapp/formats";
// The licence as people see it (no crypto: safe for the browser).
export * from "./licence/state";
// The product key's one spelling (pure: the setup field groups it as the licence server hashes it).
export * from "./licence/product-key";
// Phase 6A: the watch rules and the paused words (pure: the screens show the same limits).
export * from "./security/rules";
export * from "./security/copy";
export * from "./security/export-code";
export * from "./words/plural";
export * from "./audit/words";
// Live sheets (2026-11-14): the rule, the columns and the words; the write plan is server-only (./index).
export * from "./live-sheets/rule";
export * from "./live-sheets/rows";
export * from "./live-sheets/words";
export * from "./words/greeting";
export * from "./words/first-name";
export * from "./words/bytes";
export * from "./storage";
export * from "./words/hours";
// LUME AI's tasks (spec 2026-10-18): what each is given and must answer, and the rules on it. zod only.
export * from "./ai";
// What's new in LUME (spec 2026-11-02): each release's stories and who sees them. Pure.
export * from "./whats-new";
// Instagram flows as a graph (plan 2026-11-23-flow-builder): the builder's model, its checks, Meta's message limits
// and the interpreter its phone test runs in the browser. zod only, no server code.
export {
  blocking as flowBlocking,
  exitsOf,
  GRAPH_LIMITS,
  isGraph,
  TIME_SPAN,
  toGraph,
  validateGraph,
  type FlowGraph,
  type GNode,
  type GraphCondition,
  type Next as FlowNext,
  type Problem as FlowProblem,
  type UpdateAction,
} from "./instagram/graph";
export { graphRefs, nextAt, stepGraph, type GraphTurn } from "./instagram/graph-run";
// The ready-made flows (plan 2026-11-25-instagram-screens D4): the New flow sheet shows them as the API makes them.
export {
  READY_FLOWS,
  READY_GROUPS,
  READY_KEYS,
  readyFlow,
  type ReadyFlow,
  type ReadyGroup,
  type ReadyKey,
} from "./instagram/templates";
// LUME AI builds a flow (C1): the builder plays the answer's steps into its draft (zod and the graph only).
export { applyOps, type GraphOp } from "./ai/flow-build";
export { IG_LIMITS, messageProblems, textBytes, type IgOutMessage } from "./instagram/limits";
export { foldKeyword, matchKeyword, type KeywordMode } from "./instagram/keywords";
export { IG_WINDOW_MS } from "./instagram/window";
export {
  BOOK_BUTTON,
  NEW_RUN,
  type FlowAction,
  type FlowCtx,
  type FlowEvent,
  type FlowStep,
  type RunState,
} from "./instagram/flows";
// Team Chat (plan 2026-11-24-team-chat-2a): its limits and rules, the same on screen as on the server.
export * from "./chat/mentions";
export * from "./chat/rules";
