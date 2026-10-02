import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, MAPPABLE_TARGETS, suggestMapping, validateMapping, type Mapping } from "./mapping";
import { mapOf, testContext, testRules } from "./test-context";

const ctx = testContext();
const target = (m: Mapping, column: number) => {
  const c = m.columns[column]!;
  return c.to === "field" ? c.field : c.to === "name_part" ? `name_part:${c.part}` : c.to;
};

describe("suggestMapping", () => {
  it("matches common headers, and leaves anything unsure as Ignore", () => {
    const m = suggestMapping(
      ["Full Name", "Mobile No.", "E-mail", "IG", "Timestamp", "Assigned to", "Status", "Favourite colour"],
      ctx.fields,
    );
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => target(m, i))).toEqual([
      "name",
      "phone",
      "email",
      "instagram",
      "lead_created_at",
      "owner",
      "stage",
      "ignore",
    ]);
  });

  it("combines first and last name columns", () => {
    const m = suggestMapping(["First name", "Last name", "WhatsApp"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["name_part:first", "name_part:last", "phone"]);
  });

  it("matches custom fields by label, and never the same field twice", () => {
    const m = suggestMapping(["Struggles", "struggles", "Tier"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["struggles", "ignore", "tier"]);
  });

  it("never suggests Source, hidden, view-only or archived fields", () => {
    const m = suggestMapping(["Source", "Secret", "Gone"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("starts from a remembered mapping, dropping anything that no longer exists", () => {
    const memory = mapOf(["name", "gone", "tier"]);
    const m = suggestMapping(["Name", "Old", "Tier"], ctx.fields, memory);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["name", "ignore", "tier"]);
  });

  it("offers tags and lost reason as targets, never Source", () => {
    const keys = MAPPABLE_TARGETS(ctx.fields).map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["name", "phone", "tags", "lost_reason", "struggles"]));
    expect(keys).not.toEqual(expect.arrayContaining(["source", "secret", "gone"]));
  });
});

describe("validateMapping", () => {
  const codes = (m: Mapping, r = testRules(), c = ctx) => validateMapping(m, r, c).map((p) => p.code);

  it("accepts a plain mapping", () => expect(codes(mapOf(["name", "phone"]))).toEqual([]));

  it("refuses the same field twice, unknown or archived fields, and fields the importer can't edit", () => {
    expect(codes(mapOf(["name", "name"]))).toContain("FIELD_TWICE");
    expect(codes(mapOf(["name", "nope"]))).toContain("UNKNOWN_FIELD");
    expect(codes(mapOf(["name", "gone"]))).toContain("UNKNOWN_FIELD");
    expect(codes(mapOf(["name", "secret"]))).toContain("FIELD_NOT_EDITABLE");
    expect(codes(mapOf(["name", "source"]))).toContain("SOURCE_NOT_MAPPABLE");
  });

  it("needs a name column only when rows without a name are errors", () => {
    expect(codes(mapOf(["phone"]))).toEqual([]);
    expect(codes(mapOf(["phone"]), testRules({ noName: "error" }))).toContain("NO_NAME_COLUMN");
  });

  it("needs a first name when a last name is mapped", () => {
    const m: Mapping = { columns: [{ column: 0, to: "name_part", part: "last" }], createMissingTags: false };
    expect(codes(m)).toContain("LAST_WITHOUT_FIRST");
  });

  it("checks new fields: permission and a free, unique label", () => {
    const m = (label: string): Mapping => ({
      columns: [
        { column: 0, to: "field", field: "name" },
        { column: 1, to: "new_field", label, type: "text" },
      ],
      createMissingTags: false,
    });
    expect(codes(m("Referred by"))).toEqual([]);
    expect(codes(m("Tier"))).toContain("NEW_FIELD_LABEL_TAKEN");
    expect(codes(m("Referred by"), testRules(), testContext({ canManageFields: false }))).toContain(
      "NEW_FIELD_NOT_ALLOWED",
    );
    // The import creates the field itself, so it holds the new field to the Fields screen's own limits.
    expect(codes(m("x".repeat(61)))).toContain("NEW_FIELD_LABEL_TOO_LONG");
    const badType: Mapping = {
      columns: [{ column: 0, to: "new_field", label: "Odd", type: "spreadsheet" as never }],
      createMissingTags: false,
    };
    expect(codes(badType)).toContain("NEW_FIELD_TYPE");
  });

  it("asks for a default for every required custom field no column covers (spec amendment 3)", () => {
    const c = testContext({
      fields: ctx.fields.map((x) => (x.key === "tier" ? { ...x, isRequired: true } : x)),
    });
    expect(codes(mapOf(["name"]), testRules(), c)).toContain("REQUIRED_FIELD_UNCOVERED");
    // It names the field, so the Rules screen can ask for exactly that default.
    expect(validateMapping(mapOf(["name"]), testRules(), c)).toContainEqual(
      expect.objectContaining({ code: "REQUIRED_FIELD_UNCOVERED", field: "tier" }),
    );
    expect(codes(mapOf(["name"]), testRules({ requiredDefaults: { tier: "o-gold" } }), c)).toEqual([]);
    expect(codes(mapOf(["name", "tier"]), testRules(), c)).toEqual([]);
  });

  it("checks new options and tags against the importer's permissions", () => {
    const m = { ...mapOf(["name", "tier"]), addOptions: { tier: ["Platinum"] }, createMissingTags: true };
    expect(codes(m)).toEqual([]);
    expect(codes(m, testRules(), testContext({ canManageFields: false, canManageTags: false }))).toEqual(
      expect.arrayContaining(["NEW_OPTION_NOT_ALLOWED", "NEW_TAG_NOT_ALLOWED"]),
    );
    expect(codes({ ...mapOf(["name", "paid"]), addOptions: { paid: ["Maybe"] } })).toContain("UNKNOWN_FIELD");
  });

  it("checks the rules: stages, owners, and assigning without permission", () => {
    expect(codes(mapOf(["name"]), testRules({ stageId: "s-nope" }))).toContain("UNKNOWN_STAGE");
    expect(codes(mapOf(["name"]), testRules({ reopenClosedTo: "s-won" }))).toContain("REOPEN_NOT_OPEN");
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-old" } }))).toContain(
      "OWNER_INACTIVE",
    );
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "round_robin", userIds: [] } }))).toContain(
      "ROUND_ROBIN_EMPTY",
    );
    const noAssign = testContext({ canAssign: false });
    expect(
      codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-riya" } }), noAssign),
    ).toContain("CANNOT_ASSIGN");
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-me" } }), noAssign)).toEqual(
      [],
    );
  });

  it("has sensible defaults", () => {
    expect(DEFAULT_RULES({ pipelineId: "p1", stageId: "s-new", country: "AE" })).toEqual(testRules());
  });
});

describe("an export's LUME ref column (6B)", () => {
  it("is always ignored, whatever was remembered for that place", () => {
    const ctx = testContext({ headerCount: 3 });
    expect(suggestMapping(["Name", "Phone", "LUME ref"], ctx.fields).columns[2]).toEqual({
      column: 2,
      to: "ignore",
    });
    const remembered = suggestMapping(["Name", "Phone", "Notes"], ctx.fields);
    remembered.columns[2] = { column: 2, to: "field", field: "email" };
    expect(suggestMapping(["Name", "Phone", "lume  REF"], ctx.fields, remembered).columns[2]).toEqual({
      column: 2,
      to: "ignore",
    });
  });
});
