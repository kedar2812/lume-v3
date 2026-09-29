import type { TemplateCategory } from "../messaging/render";
import type { FieldType } from "./custom-fields";

export type StageKind = "open" | "won" | "lost";
export type StageSeed = { name: string; kind: StageKind; color: string; winProbability: number };
export type FieldSeed = {
  key: string;
  label: string;
  type: FieldType;
  options?: { label: string; color?: string }[];
};
export type TemplateSeed = { name: string; category: TemplateCategory; body: string };
export type Preset = {
  key: PresetKey;
  label: string;
  pipeline: { name: string; stages: StageSeed[] };
  fields: FieldSeed[];
  lostReasons: string[];
  /** Starter WhatsApp templates (Phase 4A): generic wording the business makes its own. */
  templates: TemplateSeed[];
  /** Where a stage sends a lead after a message is sent, or a reply is logged: [from, to] by name. */
  moves: { afterSent: [string, string][]; afterReply: [string, string][] };
};

/** Six starters every preset shares: examples to edit, never a client's own words. */
const STARTER_TEMPLATES: TemplateSeed[] = [
  {
    name: "First hello",
    category: "first_touch",
    body: "Hi {{lead.first_name}}, this is {{owner.first_name}} from {{business.name}}. Thanks for reaching out! When would suit you for a quick call?",
  },
  {
    name: "Gentle nudge",
    category: "follow_up",
    body: "Hi {{lead.first_name}}, just checking in on my last message. Happy to answer any questions. – {{owner.first_name}}",
  },
  {
    name: "Call reminder (day before)",
    category: "reminder",
    body: "Hi {{lead.first_name}}, looking forward to our call tomorrow! If the time no longer works, just reply here. – {{owner.first_name}}",
  },
  {
    name: "Call reminder (hour before)",
    category: "reminder",
    body: "Hi {{lead.first_name}}, we speak in about an hour. See you soon! – {{owner.first_name}}",
  },
  {
    name: "After the call",
    category: "follow_up",
    body: "Thank you for your time today, {{lead.first_name}}. Let me know if any questions come up. – {{owner.first_name}}",
  },
  {
    name: "Checking back in",
    category: "re_engagement",
    body: "Hi {{lead.first_name}}, it's been a while! Is now a better time to pick things up with {{business.name}}? Just reply here.",
  },
];
/**
 * Four views every new install starts with (4B), owned by the owner and shared with every role made at
 * setup. They name no stage (kinds and dates only), so they suit any preset.
 */
export const STARTER_VIEWS: { name: string; color: string; filters: Record<string, string> }[] = [
  { name: "My overdue", color: "danger", filters: { ownerId: "me", followUpOverdue: "true" } },
  { name: "New today", color: "accent", filters: { createdDays: "1" } },
  { name: "No reply 3+ days", color: "warn", filters: { noReplyDays: "3" } },
  { name: "Lost — re-engage", color: "meet", filters: { lostDaysAgo: "30" } },
];
export type PresetKey = "coaching" | "general";

/** Report §6: core fields are real columns on every install; they can be relabelled and hidden, never deleted. */
export const CORE_FIELDS: { key: string; label: string; type: FieldType; isRequired: boolean }[] = [
  { key: "name", label: "Name", type: "text", isRequired: true },
  { key: "phone", label: "Phone", type: "phone", isRequired: false },
  { key: "email", label: "Email", type: "email", isRequired: false },
  { key: "instagram", label: "Instagram", type: "instagram", isRequired: false },
  { key: "owner", label: "Handled by (owner)", type: "user", isRequired: false },
  { key: "stage", label: "Stage", type: "select", isRequired: true },
  { key: "source", label: "Source", type: "text", isRequired: false },
  { key: "value", label: "Value", type: "currency", isRequired: false },
  { key: "lead_created_at", label: "Date", type: "date", isRequired: false },
];
export const CORE_FIELD_KEYS: ReadonlySet<string> = new Set(CORE_FIELDS.map((f) => f.key));

export const PRESETS: Record<PresetKey, Preset> = {
  // An industry starter: the stages, options and lost reasons are examples the admin edits.
  coaching: {
    key: "coaching",
    label: "Coaching / consulting",
    pipeline: {
      name: "Coaching sales",
      stages: [
        { name: "New", kind: "open", color: "accent", winProbability: 5 },
        { name: "Message sent", kind: "open", color: "cyan", winProbability: 10 },
        { name: "Replied", kind: "open", color: "meet", winProbability: 20 },
        { name: "Call booked", kind: "open", color: "warn", winProbability: 40 },
        { name: "Call done", kind: "open", color: "warn", winProbability: 60 },
        { name: "Follow-up later", kind: "open", color: "neutral", winProbability: 10 },
        { name: "Won", kind: "won", color: "ok", winProbability: 100 },
        { name: "Lost", kind: "lost", color: "danger", winProbability: 0 },
      ],
    },
    fields: [
      {
        key: "struggles",
        label: "Struggles",
        type: "multi_select",
        options: [
          { label: "Confidence", color: "accent" },
          { label: "Career direction", color: "cyan" },
          { label: "Relationships", color: "meet" },
          { label: "Stress & anxiety", color: "warn" },
          { label: "Health & habits", color: "ok" },
          { label: "Productivity", color: "neutral" },
        ],
      },
      { key: "handled_by", label: "Handled by", type: "user" },
    ],
    lostReasons: [
      "Not interested",
      "Price too high",
      "No response",
      "Bad timing",
      "Chose someone else",
      "Not a fit",
    ],
    templates: STARTER_TEMPLATES,
    moves: { afterSent: [["New", "Message sent"]], afterReply: [["Message sent", "Replied"]] },
  },
  general: {
    key: "general",
    label: "General sales",
    pipeline: {
      name: "Sales",
      stages: [
        { name: "New", kind: "open", color: "accent", winProbability: 10 },
        { name: "Contacted", kind: "open", color: "cyan", winProbability: 20 },
        { name: "Qualified", kind: "open", color: "meet", winProbability: 40 },
        { name: "Proposal", kind: "open", color: "warn", winProbability: 60 },
        { name: "Won", kind: "won", color: "ok", winProbability: 100 },
        { name: "Lost", kind: "lost", color: "danger", winProbability: 0 },
      ],
    },
    fields: [],
    lostReasons: ["Not interested", "Price", "No response", "Timing", "Went with a competitor"],
    templates: STARTER_TEMPLATES,
    moves: { afterSent: [["New", "Contacted"]], afterReply: [] },
  },
};
