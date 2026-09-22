import { describe, expect, it } from "vitest";
import { buildCustomFieldSchemas, normalizeInstagram, type FieldDef } from "./custom-fields";
import { fieldAccessOf, mergeFieldAccess } from "./field-access";
import { maskEmail, maskInstagram, maskPhone } from "./mask";
import { formatPhone, normalizePhone } from "./phone";
import { CORE_FIELDS, CORE_FIELD_KEYS, PRESETS } from "./presets";

describe("phone normalisation (report §8.4: never guess silently)", () => {
  it.each([
    ["+971 50 123 4567", null, { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["00971-50-123-4567", null, { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["(050) 123 4567", "AE", { e164: "+971501234567", countryIso: "AE", status: "valid" }],
    ["+91 98765 43210", "AE", { e164: "+919876543210", countryIso: "IN", status: "valid" }],
    ["9876543210", null, { e164: null, countryIso: null, status: "needs_country" }],
    ["9876543210", "AE", { e164: null, countryIso: null, status: "needs_country" }],
    ["+971 12", null, { e164: null, countryIso: null, status: "invalid" }],
    ["call me", "AE", { e164: null, countryIso: null, status: "invalid" }],
    ["   ", "AE", { e164: null, countryIso: null, status: "missing" }],
  ] as const)("%s (default %s)", (input, country, expected) => {
    expect(normalizePhone(input, country)).toMatchObject(expected);
  });

  it("keeps the raw value exactly as received", () => {
    expect(normalizePhone(" 050 123 4567 ", "AE").raw).toBe("050 123 4567");
    expect(normalizePhone(null).raw).toBeNull();
  });

  it("formats international for display", () => {
    expect(formatPhone("+971501234567")).toBe("+971 50 123 4567");
  });
});

describe("masking (spec §3 Leads)", () => {
  it("phone keeps the country code, two national digits and the last two", () => {
    expect(maskPhone({ e164: "+971501234567", raw: "0501234567" })).toBe("+971 50 ••• ••67");
    expect(maskPhone({ e164: null, raw: "98765 43210" })).toBe("••• ••10");
  });
  it("email keeps the first letter and the domain", () => {
    expect(maskEmail("asha.patel@gmail.com")).toBe("a•••@gmail.com");
    expect(maskEmail("x@y.co")).toBe("x•••@y.co");
  });
  it("instagram keeps the first and last character", () => {
    expect(maskInstagram("asha.k")).toBe("@a•••k");
    expect(maskInstagram("a")).toBe("@a•••");
  });
});

const defs: FieldDef[] = [
  {
    id: "f1",
    key: "struggles",
    label: "Struggles",
    type: "multi_select",
    isCore: false,
    isRequired: false,
    archived: false,
    options: [
      { id: "o1", label: "Confidence" },
      { id: "o2", label: "Career" },
      { id: "o3", label: "Old", archived: true },
    ],
  },
  {
    id: "f2",
    key: "budget",
    label: "Budget",
    type: "currency",
    isCore: false,
    isRequired: true,
    archived: false,
    options: [],
  },
  {
    id: "f3",
    key: "call_on",
    label: "Call on",
    type: "date",
    isCore: false,
    isRequired: false,
    archived: false,
    options: [],
  },
  {
    id: "f4",
    key: "alt_phone",
    label: "Alt phone",
    type: "phone",
    isCore: false,
    isRequired: false,
    archived: false,
    options: [],
  },
  {
    id: "f5",
    key: "legacy",
    label: "Legacy",
    type: "text",
    isCore: false,
    isRequired: false,
    archived: true,
    options: [],
  },
  {
    id: "f6",
    key: "handled_by",
    label: "Handled by",
    type: "user",
    isCore: false,
    isRequired: false,
    archived: false,
    options: [],
  },
  {
    id: "c1",
    key: "name",
    label: "Name",
    type: "text",
    isCore: true,
    isRequired: true,
    archived: false,
    options: [],
  },
];

describe("custom-field schemas (report §6)", () => {
  const { create, patch } = buildCustomFieldSchemas(defs, { defaultCountry: "AE" });

  it("accepts valid values and normalises them", () => {
    expect(
      create.parse({
        struggles: ["o1", "o2"],
        budget: 1500.5,
        call_on: "2026-10-01",
        alt_phone: "050 123 4567",
        handled_by: "0190e0c0-0000-7000-8000-000000000001",
      }),
    ).toEqual({
      struggles: ["o1", "o2"],
      budget: 1500.5,
      call_on: "2026-10-01",
      alt_phone: "+971501234567",
      handled_by: "0190e0c0-0000-7000-8000-000000000001",
    });
  });

  it("enforces required fields on create but not on patch", () => {
    expect(create.safeParse({}).success).toBe(false);
    expect(patch.safeParse({}).success).toBe(true);
  });

  it("rejects unknown, archived, core and badly typed values", () => {
    expect(patch.safeParse({ nope: 1 }).success).toBe(false);
    expect(patch.safeParse({ legacy: "x" }).success).toBe(false);
    expect(patch.safeParse({ name: "x" }).success).toBe(false);
    expect(patch.safeParse({ struggles: ["o3"] }).success).toBe(false); // archived option
    expect(patch.safeParse({ struggles: ["o1", "o1"] }).success).toBe(false);
    expect(patch.safeParse({ budget: 10.001 }).success).toBe(false);
    expect(patch.safeParse({ call_on: "01/10/2026" }).success).toBe(false);
    expect(patch.safeParse({ alt_phone: "9876543210x" }).success).toBe(false);
  });

  it("null clears an optional field, never a required one", () => {
    expect(patch.parse({ call_on: null })).toEqual({ call_on: null });
    expect(patch.safeParse({ budget: null }).success).toBe(false);
  });

  it("normalises Instagram handles", () => {
    expect(normalizeInstagram("@Asha.K ")).toBe("asha.k");
  });
});

describe("field access merge (report §7.1)", () => {
  it("is widest-wins across roles, and a role without a row means edit", () => {
    const rows = [
      { roleId: "r1", fieldId: "phone", access: "hidden" as const },
      { roleId: "r2", fieldId: "phone", access: "view" as const },
      { roleId: "r1", fieldId: "budget", access: "hidden" as const },
    ];
    const m = mergeFieldAccess(["r1", "r2"], rows);
    expect(fieldAccessOf(m, "phone")).toBe("view");
    expect(fieldAccessOf(m, "budget")).toBe("edit"); // r2 has no row for budget
    expect(fieldAccessOf(mergeFieldAccess(["r1"], rows), "budget")).toBe("hidden");
    expect(fieldAccessOf(m, "anything-else")).toBe("edit");
  });
});

describe("presets (report §15.3, spec §1 #7)", () => {
  it("define every core field once", () => {
    expect(CORE_FIELDS.map((f) => f.key)).toEqual([
      "name",
      "phone",
      "email",
      "instagram",
      "owner",
      "stage",
      "source",
      "value",
      "lead_created_at",
    ]);
    expect(CORE_FIELD_KEYS.has("phone")).toBe(true);
  });

  it("each pipeline has open stages first and at least one won and one lost stage", () => {
    for (const p of Object.values(PRESETS)) {
      const kinds = p.pipeline.stages.map((s) => s.kind);
      expect(kinds[0]).toBe("open");
      expect(kinds).toContain("won");
      expect(kinds).toContain("lost");
      for (const f of p.fields) expect(CORE_FIELD_KEYS.has(f.key)).toBe(false);
    }
  });

  it("Nupuur's preset is the report's pipeline and fields", () => {
    const c = PRESETS.coaching;
    expect(c.pipeline.stages.map((s) => s.name)).toEqual([
      "New",
      "Message sent",
      "Replied",
      "Call booked",
      "Call done",
      "Follow-up later",
      "Won",
      "Lost",
    ]);
    expect(c.fields.map((f) => [f.key, f.type])).toEqual([
      ["struggles", "multi_select"],
      ["handled_by", "user"],
    ]);
  });
});
