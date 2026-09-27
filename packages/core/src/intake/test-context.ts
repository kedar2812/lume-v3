import type { IntakeField, MapContext, Mapping, Rules } from "./mapping";

const f = (
  key: string,
  label: string,
  type: IntakeField["type"],
  extra: Partial<IntakeField> = {},
): IntakeField => ({
  id: `f-${key}`,
  key,
  label,
  type,
  options: [],
  isCore: false,
  isRequired: false,
  archived: false,
  access: "edit",
  ...extra,
});

/** A coaching business in Dubai, as the tests see it. Only tests import this file. */
export const testContext = (over: Partial<MapContext> = {}): MapContext => ({
  fields: [
    f("name", "Name", "text", { isCore: true, isRequired: true }),
    f("phone", "Phone", "phone", { isCore: true }),
    f("email", "Email", "email", { isCore: true }),
    f("instagram", "Instagram", "instagram", { isCore: true }),
    f("owner", "Handled by (owner)", "user", { isCore: true }),
    f("stage", "Stage", "select", { isCore: true, isRequired: true }),
    f("source", "Source", "text", { isCore: true }),
    f("value", "Value", "currency", { isCore: true }),
    f("lead_created_at", "Date", "date", { isCore: true }),
    f("struggles", "Struggles", "multi_select", {
      options: [
        { id: "o-conf", label: "Confidence" },
        { id: "o-career", label: "Career switch" },
      ],
    }),
    f("tier", "Tier", "select", {
      options: [
        { id: "o-gold", label: "Gold" },
        { id: "o-silver", label: "Silver" },
        { id: "o-old", label: "Bronze", archived: true },
      ],
    }),
    f("paid", "Paid", "boolean"),
    f("budget", "Budget", "currency"),
    f("call_at", "Call at", "datetime"),
    f("website", "Website", "url"),
    f("alt_phone", "Alt phone", "phone"),
    f("coach", "Coach", "user"),
    f("notes", "Notes", "long_text"),
    f("secret", "Secret", "text", { access: "hidden" }),
    f("gone", "Gone", "text", { archived: true }),
  ],
  stages: [
    { id: "s-new", name: "New", kind: "open" },
    { id: "s-booked", name: "Call booked", kind: "open" },
    { id: "s-won", name: "Won", kind: "won" },
    { id: "s-lost", name: "Lost", kind: "lost" },
  ],
  people: [
    { id: "u-riya", name: "Riya Sharma", email: "riya@brightpath.test", active: true },
    { id: "u-sam1", name: "Sam Lee", email: "sam.lee@brightpath.test", active: true },
    { id: "u-sam2", name: "Sam Lee", email: "sam.l@brightpath.test", active: true },
    { id: "u-old", name: "Omar Gone", email: "omar@brightpath.test", active: false },
    { id: "u-me", name: "Maya Kapoor", email: "maya@brightpath.test", active: true },
  ],
  tags: [
    { id: "t-hot", label: "Hot" },
    { id: "t-vip", label: "VIP" },
  ],
  lostReasons: [{ id: "r-price", label: "Price" }],
  currency: "AED",
  country: "AE",
  today: "2026-09-27",
  timezone: "Asia/Dubai",
  importerId: "u-me",
  canAssign: true,
  canManageFields: true,
  canManageTags: true,
  headerCount: 20,
  dateOrders: {},
  decimalMarks: {},
  ...over,
});

export const testRules = (over: Partial<Rules> = {}): Rules => ({
  matchOn: ["phone", "email", "instagram"],
  onMatch: "merge",
  reopenClosedTo: null,
  pipelineId: "p1",
  stageId: "s-new",
  owner: { mode: "unassigned" },
  defaultCountry: "AE",
  noName: "use_contact",
  unknownOwner: "fallback",
  requiredDefaults: {},
  ...over,
});

/** A mapping from "field key per column" shorthand: ["name", "phone", null, …]. */
export const mapOf = (keys: (string | null)[], createMissingTags = false): Mapping => ({
  columns: keys.map((k, column) =>
    k === null ? { column, to: "ignore" as const } : { column, to: "field" as const, field: k },
  ),
  createMissingTags,
});
