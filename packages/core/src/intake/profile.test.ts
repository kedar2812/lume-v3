import { describe, expect, it } from "vitest";
import { choicesOf, profileColumns } from "./profile";

/** What a column holds, from every row, and the field a new one from it should be (imports, 2026-10-25). */
const col = (values: string[], header = "column") =>
  profileColumns(
    values.map((v) => [v]),
    [header],
    { country: "IN" },
  )[0]!;

describe("a column's profile", () => {
  it("empty in every row: nothing to keep", () => {
    expect(col(["", "  ", ""])).toMatchObject({ kind: "empty", filled: 0, suggest: "text" });
  });

  it("how many rows fill it, blanks left out", () => {
    expect(col(["a", "", "b"]).filled).toBe(2);
  });

  it("numbers: a number, or an amount when the header or a currency sign says money", () => {
    expect(col(["3", "12", "4"], "rooms")).toMatchObject({ kind: "number", suggest: "number" });
    expect(col(["500000", "15,00,000"], "budget")).toMatchObject({ kind: "money", suggest: "currency" });
    expect(col(["₹4,500", "3000"], "anything")).toMatchObject({ kind: "money", suggest: "currency" });
    expect(col(["12", "abc"], "rooms").kind).not.toBe("number");
  });

  it("dates, yes or no, emails, links and phone numbers", () => {
    expect(col(["2026-11-03", "04/03/2026", "4 Mar 2026"])).toMatchObject({ kind: "date", suggest: "date" });
    expect(col(["yes", "No", "yes"])).toMatchObject({ kind: "boolean", suggest: "boolean" });
    expect(col(["a@x.com", "b@y.in"])).toMatchObject({ kind: "email", suggest: "email" });
    expect(col(["https://x.com/a", "www.y.in"])).toMatchObject({ kind: "url", suggest: "url" });
    expect(col(["+919876543210", "98765 43210", "+971 50 123 4567"])).toMatchObject({
      kind: "phone",
      suggest: "phone",
    });
    // 0 and 1 alone are numbers, not yes or no.
    expect(col(["0", "1", "1"]).kind).toBe("number");
  });

  it("a few values over and over: a choice, in the order they first appear, one spelling each", () => {
    const words = Array.from({ length: 12 }, (_, i) => ["Residential", "Commercial", "residential"][i % 3]!);
    expect(col(words)).toMatchObject({
      kind: "choice",
      values: ["Residential", "Commercial"],
      multi: false,
      suggest: "select",
    });
    const several = Array.from({ length: 9 }, (_, i) => (i % 2 ? "Kitchen, Bedroom" : "Kitchen"));
    expect(col(several)).toMatchObject({ kind: "choice", values: ["Kitchen", "Bedroom"], multi: true });
    expect(col(several).suggest).toBe("multi_select");
  });

  it("names, notes and anything else: text; long words, long text", () => {
    expect(col(["Asha", "Ravi", "Meena"])).toMatchObject({ kind: "text", suggest: "text" });
    expect(col(["x".repeat(300)])).toMatchObject({ kind: "text", suggest: "long_text" });
  });
});

describe("a new choice field's options", () => {
  it("every value in the column, first spelling first, split for several choices", () => {
    const rows = [["Kitchen, Bedroom"], ["kitchen"], [""], ["Study"], ["KITCHEN"]];
    expect(choicesOf(rows, 0, false)).toEqual(["Kitchen, Bedroom", "kitchen", "Study"]);
    expect(choicesOf(rows, 0, true)).toEqual(["Kitchen", "Bedroom", "Study"]);
    const many = Array.from({ length: 150 }, (_, i) => [`v${i}`]);
    expect(choicesOf(many, 0, false)).toHaveLength(150);
  });
});

describe("what stops a column becoming a new field", () => {
  const rows = (vs: string[]) => vs.map((v) => [v]);
  const m = (type: "text" | "select" | "multi_select") => ({
    createMissingTags: false,
    columns: [{ column: 0, to: "new_field" as const, label: "Space", type }],
  });
  it("nothing in it; more values than a choice holds; a value too long to be a choice", async () => {
    const { newFieldProblems, profileColumns: p } = await import("./profile");
    const empty = rows(["", ""]);
    expect(newFieldProblems(m("text"), p(empty, ["x"], { country: null }), empty).map((i) => i.code)).toEqual(
      ["NEW_FIELD_EMPTY"],
    );
    const many = rows(Array.from({ length: 101 }, (_, i) => `v${i}`));
    expect(newFieldProblems(m("select"), p(many, ["x"], { country: null }), many)[0]).toMatchObject({
      code: "NEW_FIELD_TOO_MANY_CHOICES",
      message: "This column has 101 different values; a choice field holds up to 100. Make it Text.",
    });
    const long = rows(["Residential", "x".repeat(61)]);
    expect(newFieldProblems(m("select"), p(long, ["x"], { country: null }), long)[0]).toMatchObject({
      code: "NEW_FIELD_CHOICE_TOO_LONG",
      message: "A choice can be up to 60 characters, and this column has longer values. Make it Text.",
    });
    expect(newFieldProblems(m("text"), p(long, ["x"], { country: null }), long)).toEqual([]);
  });
});
