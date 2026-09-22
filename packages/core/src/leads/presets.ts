import type { FieldType } from "./custom-fields";

export type StageKind = "open" | "won" | "lost";
export type StageSeed = { name: string; kind: StageKind; color: string; winProbability: number };
export type FieldSeed = {
  key: string;
  label: string;
  type: FieldType;
  options?: { label: string; color?: string }[];
};
export type Preset = {
  key: PresetKey;
  label: string;
  pipeline: { name: string; stages: StageSeed[] };
  fields: FieldSeed[];
  lostReasons: string[];
};
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
  // Nupuur's install (report §15.3, spec §1 #7). Options and lost reasons are starters Tasneem can edit.
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
  },
};
