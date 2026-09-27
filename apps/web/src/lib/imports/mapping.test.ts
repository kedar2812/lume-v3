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
