import { describe, expect, it } from "vitest";
import { FILLABLE_TYPES, fieldValueFrom } from "./fill-fields";

/** LUME AI fills in a lead's details from what the lead said (Autopilot spec 2026-10-19 §1.3 "Fill in lead details"). */
const opt = (id: string, label: string, archived = false) => ({ id, label, archived });
const select = {
  type: "select" as const,
  options: [opt("o1", "Apartment"), opt("o2", "Villa"), opt("o3", "Plot", true)],
};
const multi = { type: "multi_select" as const, options: select.options };
const plain = (type: (typeof FILLABLE_TYPES)[number]) => ({ type, options: [] });

describe("a field's value from LUME AI's words", () => {
  it("text is trimmed; blank is nothing", () => {
    expect(fieldValueFrom(plain("text"), "  3BHK in Kokapet ")).toBe("3BHK in Kokapet");
    expect(fieldValueFrom(plain("long_text"), "Moving in March.")).toBe("Moving in March.");
    expect(fieldValueFrom(plain("text"), "   ")).toBeUndefined();
  });

  it("numbers and amounts as written, with grouping and a currency sign; words aren't guessed", () => {
    expect(fieldValueFrom(plain("number"), "15,00,000")).toBe(1500000);
    expect(fieldValueFrom(plain("currency"), "₹4,500")).toBe(4500);
    expect(fieldValueFrom(plain("currency"), "AED 12,000.50")).toBe(12000.5);
    expect(fieldValueFrom(plain("number"), "3")).toBe(3);
    expect(fieldValueFrom(plain("number"), "4.5 lakh")).toBeUndefined();
    expect(fieldValueFrom(plain("number"), "about 20")).toBeUndefined();
    expect(fieldValueFrom(plain("currency"), "-500")).toBeUndefined();
    expect(fieldValueFrom(plain("currency"), "10.555")).toBeUndefined();
  });

  it("a date only as a real calendar day", () => {
    expect(fieldValueFrom(plain("date"), "2026-11-03")).toBe("2026-11-03");
    expect(fieldValueFrom(plain("date"), "2026-02-30")).toBeUndefined();
    expect(fieldValueFrom(plain("date"), "next Tuesday")).toBeUndefined();
  });

  it("yes or no", () => {
    expect(fieldValueFrom(plain("boolean"), "Yes")).toBe(true);
    expect(fieldValueFrom(plain("boolean"), "false")).toBe(false);
    expect(fieldValueFrom(plain("boolean"), "maybe")).toBeUndefined();
  });

  it("a choice by its label, any case; never an archived one or a label that isn't there", () => {
    expect(fieldValueFrom(select, " villa ")).toBe("o2");
    expect(fieldValueFrom(select, "Plot")).toBeUndefined();
    expect(fieldValueFrom(select, "Bungalow")).toBeUndefined();
    expect(fieldValueFrom(multi, "Apartment, villa")).toEqual(["o1", "o2"]);
    expect(fieldValueFrom(multi, "Apartment, Bungalow")).toBeUndefined();
    expect(fieldValueFrom(multi, "Villa, villa")).toEqual(["o2"]);
  });

  it("only these types are ever filled: never a contact, a person or a moment", () => {
    expect([...FILLABLE_TYPES]).toEqual([
      "text",
      "long_text",
      "number",
      "currency",
      "date",
      "boolean",
      "select",
      "multi_select",
    ]);
  });
});
