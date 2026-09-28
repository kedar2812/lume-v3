import type { IntakeField } from "@lume/core";
import { describe, expect, it } from "vitest";
import { PRESETS, presetMapping } from "./presets";

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
const fields = [
  f("name", "Name", "text", { isCore: true, isRequired: true }),
  f("phone", "Phone", "phone", { isCore: true }),
  f("email", "Email", "email", { isCore: true }),
  f("instagram", "Instagram", "instagram", { isCore: true }),
  f("source", "Source", "text", { isCore: true }),
  f("budget", "Budget", "currency"),
  f("preferred_time", "Preferred time", "text"),
  f("gone", "Gone", "text", { archived: true }),
];

describe("presets (2C spec §5)", () => {
  it("the website preset maps name, phone and email", () => {
    expect(presetMapping("website", ["name", "phone", "email"], fields).columns).toEqual([
      { column: 0, to: "field", field: "name" },
      { column: 1, to: "field", field: "phone" },
      { column: 2, to: "field", field: "email" },
    ]);
  });

  it("ManyChat's subscriber maps its name parts, contacts, Instagram, and a custom field by key", () => {
    const headers = ["first_name", "last_name", "phone", "email", "ig_username", "custom_fields.budget"];
    expect(presetMapping("manychat", headers, fields).columns).toEqual([
      { column: 0, to: "name_part", part: "first" },
      { column: 1, to: "name_part", part: "last" },
      { column: 2, to: "field", field: "phone" },
      { column: 3, to: "field", field: "email" },
      { column: 4, to: "field", field: "instagram" },
      { column: 5, to: "field", field: "budget" },
    ]);
  });

  it("any other path falls back to its last segment; custom fields match by label too, never an archived one", () => {
    const headers = ["contact.phone", "custom_fields.Preferred Time", "custom_fields.gone", "utm.campaign"];
    expect(presetMapping("zapier", headers, fields).columns).toEqual([
      { column: 0, to: "field", field: "phone" },
      { column: 1, to: "field", field: "preferred_time" },
      { column: 2, to: "ignore" },
      { column: 3, to: "ignore" },
    ]);
  });

  it("ManyChat stays hidden until it's been verified; it posts with a token, the rest sign", () => {
    expect(PRESETS.manychat).toMatchObject({ hidden: true, mode: "token" });
    expect(PRESETS.website.mode).toBe("signed");
    expect(PRESETS.zapier.hidden).toBeUndefined();
  });
});
