import type { Catalog, Lead, Stage } from "./types";

/**
 * Fixtures shared by the leads tests. Only tests import this file, so it never ships. Test files never
 * import each other, because that would register their tests twice.
 */

/** A lead as a masked sales rep receives it; override what a test cares about. */
export const testLead = (over: Partial<Lead> = {}): Lead => ({
  id: "l1",
  version: 1,
  pipelineId: "p1",
  stageId: "s-new",
  ownerId: "u-riya",
  name: "Aisha Khan",
  phone: { display: "+971 50 ••• ••67", masked: true, status: "valid" },
  email: null,
  instagram: null,
  value: 4500,
  currency: "AED",
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: "2026-09-24T10:00:00Z",
  tagIds: [],
  custom: {},
  contactMasked: true,
  can: { edit: true, move: true, reveal: true, assign: false, delete: false, message: true },
  ...over,
});

/** A small, realistic catalog: the Coaching preset's shape, a few fields, two people, tags, reasons. */
export function testCatalog(over: Partial<Catalog> = {}): Catalog {
  const stages: Stage[] = (
    [
      ["s-new", "New", "accent", "open"],
      ["s-sent", "Message sent", "cyan", "open"],
      ["s-booked", "Call booked", "warn", "open"],
      ["s-won", "Won", "ok", "won"],
      ["s-lost", "Lost", "danger", "lost"],
    ] as const
  ).map(([id, name, color, kind], position) => ({ id, name, color, kind, position, requiredFieldIds: [] }));
  return {
    pipelines: [{ id: "p1", name: "Coaching sales", isDefault: true, stages }],
    fields: [
      {
        id: "f-name",
        key: "name",
        label: "Name",
        type: "text",
        options: [],
        isCore: true,
        isRequired: true,
        archived: false,
        access: "edit",
      },
      {
        id: "f-phone",
        key: "phone",
        label: "Phone",
        type: "phone",
        options: [],
        isCore: true,
        isRequired: false,
        archived: false,
        access: "edit",
      },
      {
        id: "f-email",
        key: "email",
        label: "Email",
        type: "email",
        options: [],
        isCore: true,
        isRequired: false,
        archived: false,
        access: "edit",
      },
      {
        id: "f-value",
        key: "value",
        label: "Deal value",
        type: "currency",
        options: [],
        isCore: true,
        isRequired: false,
        archived: false,
        access: "edit",
      },
      {
        id: "f-str",
        key: "struggles",
        label: "Struggles",
        type: "multi_select",
        isCore: false,
        isRequired: false,
        archived: false,
        access: "edit",
        options: [
          { id: "o1", label: "Confidence" },
          { id: "o2", label: "Career switch" },
        ],
      },
      {
        id: "f-hb",
        key: "handled_by",
        label: "Handled by",
        type: "user",
        options: [],
        isCore: false,
        isRequired: false,
        archived: false,
        access: "edit",
      },
    ],
    people: [
      { id: "u-riya", name: "Riya Sharma", active: true },
      { id: "u-tas", name: "Tasneem Shaikh", active: true },
    ],
    tags: [{ id: "t-hot", label: "Hot", color: "danger" }],
    lostReasons: [{ id: "r-price", label: "Price", position: 0 }],
    products: [{ id: "pr-sig", name: "Signature 12-week", defaultValue: 4500, currency: "AED" }],
    currency: "AED",
    ...over,
  };
}
