import { describe, expect, it } from "vitest";
import { choiceOf, columnFor, settleValue, withTransform } from "./mapping";
import type { Mapping } from "./types";

const base: Mapping = {
  columns: [
    { column: 0, to: "field", field: "name" },
    { column: 1, to: "field", field: "tier" },
  ],
  createMissingTags: false,
};

describe("import mapping edits", () => {
  it("never mistakes a custom field keyed like a special choice for that choice", () => {
    const c = columnFor(0, choiceOf({ column: 0, to: "field", field: "ignore" }), "Ignore me");
    expect(c).toEqual({ column: 0, to: "field", field: "ignore" });
    expect(columnFor(0, "ignore", "X")).toEqual({ column: 0, to: "ignore" });
  });

  it("starts a new field named after the column, and drops a value map when the field changes", () => {
    expect(columnFor(2, "new_field", "  Referred by ")).toMatchObject({
      to: "new_field",
      label: "Referred by",
      type: "text",
    });
    const mapped = withTransform(base, 1, { valueMap: { Plat: "Gold" } });
    expect(columnFor(1, "struggles", "Tier", mapped.columns[1])).toEqual({
      column: 1,
      to: "field",
      field: "struggles",
    });
  });

  it("names a new field readably after a snake_case header, as Meta's lead ads export writes them", () => {
    const label = (h: string) => (columnFor(0, "new_field", h) as { label: string }).label;
    expect(label("what_type_of_commercial_space_are_you_designing?")).toBe(
      "What type of commercial space are you designing?",
    );
    expect(label("what_is_the_size_of_your_space_(sq.ft)?")).toBe("What is the size of your space (sq.ft)?");
    expect(label("is_organic")).toBe("Is organic");
    // Headers people wrote themselves stay as they are.
    expect(label("Referred by")).toBe("Referred by");
    expect(label("GST no.")).toBe("GST no.");
  });

  it("cuts a long header at a word, never mid-word, to fit a field's name", () => {
    const long = "when_are_you_looking_to_start_the_project_and_what_is_your_preferred_completion_date?";
    const got = (columnFor(0, "new_field", long) as { label: string }).label;
    expect(got.length).toBeLessThanOrEqual(60);
    expect(got).toBe("When are you looking to start the project and what is your");
  });

  it("moves a value between added, mapped and empty without leaving a trace of the old choice", () => {
    let m = settleValue(base, 1, "tier", "Platinum", "add");
    expect(m.addOptions).toEqual({ tier: ["Platinum"] });
    m = settleValue(m, 1, "tier", "Platinum", { label: "Gold" });
    expect(m.addOptions).toBeUndefined();
    expect(m.columns[1]).toMatchObject({ transform: { valueMap: { Platinum: "Gold" } } });
    m = settleValue(m, 1, "tier", "Platinum", "empty");
    expect(m.columns[1]).toMatchObject({ transform: { valueMap: { Platinum: null } } });
  });
});
