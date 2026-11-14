import { describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../rbac/engine";
import { isPermissionKey } from "../rbac/catalog";
import { TIER_LINES, tierAllows, tierFor } from "../licence/tiers";
import {
  cellText,
  countryOfPhone,
  liveSheetRuleSchema,
  metaColumns,
  planWrites,
  rowHash,
  ruleWords,
  splitName,
  type SheetRow,
  type Written,
} from "./index";

const row = (leadId: string, ...cells: (string | number | null)[]): SheetRow => ({ leadId, cells });
const written = (r: SheetRow, over: Partial<Written> = {}): Written => ({
  leadId: r.leadId,
  hash: rowHash(r.cells),
  cells: r.cells,
  editedCols: [],
  removedByHand: false,
  ...over,
});
const plan = (o: Partial<Parameters<typeof planWrites>[0]>) =>
  planWrites({ desired: [], written: [], edits: "replace", ruleMode: "reached", deleted: new Set(), ...o });

describe("live sheets: names, countries and cells", () => {
  it("splits a name into Meta's first and last", () => {
    expect(splitName("Riya Sharma")).toEqual({ fn: "Riya", ln: "Sharma" });
    expect(splitName("Riya")).toEqual({ fn: "Riya", ln: "" });
    expect(splitName("  Ana  de la Cruz ")).toEqual({ fn: "Ana", ln: "de la Cruz" });
    expect(splitName("   ")).toEqual({ fn: "", ln: "" });
  });

  it("reads a two-letter country from a phone's digits, or none", () => {
    expect(countryOfPhone("919876543210")).toBe("IN");
    expect(countryOfPhone("971501234567")).toBe("AE");
    expect(countryOfPhone("12")).toBeNull();
    expect(countryOfPhone("")).toBeNull();
  });

  it("Meta's columns, with value only when the rule includes a won stage", () => {
    expect(metaColumns(false)).toEqual(["email", "phone", "fn", "ln", "country"]);
    expect(metaColumns(true)).toEqual(["email", "phone", "fn", "ln", "country", "value"]);
  });

  it("a cell holds at most Google's 50,000 characters; empty stays empty", () => {
    expect(cellText("x".repeat(60000))).toHaveLength(50000);
    expect(cellText(null)).toBe("");
    expect(cellText(12.5)).toBe("12.5");
  });

  it("the same cells hash the same; any change hashes differently", () => {
    expect(rowHash(["a", 1, null])).toBe(rowHash(["a", 1, null]));
    expect(rowHash(["a", 1, null])).not.toBe(rowHash(["a", 1, ""]));
  });
});

describe("live sheets: what to write", () => {
  const a = row("a", "a@x.test", "919800000001");
  const b = row("b", "b@x.test", "919800000002");

  it("a new match is added, newest first as given", () => {
    expect(plan({ desired: [a, b] })).toEqual({ add: [a, b], update: [], remove: [] });
  });

  it("an unchanged lead writes nothing", () => {
    expect(plan({ desired: [a], written: [written(a)] })).toEqual({ add: [], update: [], remove: [] });
  });

  it("a changed lead is updated; with Keep them its hand-edited cells are skipped", () => {
    const a2 = row("a", "new@x.test", "919800000001");
    expect(plan({ desired: [a2], written: [written(a)] }).update).toEqual([
      { leadId: "a", cells: a2.cells, skipCols: [] },
    ]);
    expect(plan({ desired: [a2], written: [written(a, { editedCols: [1] })], edits: "keep" }).update).toEqual(
      [{ leadId: "a", cells: a2.cells, skipCols: [1] }],
    );
    // Put LUME's back: an edited cell is written again.
    expect(
      plan({ desired: [a2], written: [written(a, { editedCols: [1] })], edits: "replace" }).update,
    ).toEqual([{ leadId: "a", cells: a2.cells, skipCols: [] }]);
  });

  it("with Keep them, a hand-edited row whose lead didn't change is left alone", () => {
    expect(plan({ desired: [a], written: [written(a, { editedCols: [0] })], edits: "keep" })).toEqual({
      add: [],
      update: [],
      remove: [],
    });
  });

  it("a row deleted by hand stays deleted with Keep them, comes back with Put LUME's back", () => {
    const gone = written(a, { removedByHand: true });
    expect(plan({ desired: [a], written: [gone], edits: "keep" })).toEqual({
      add: [],
      update: [],
      remove: [],
    });
    expect(plan({ desired: [a], written: [gone], edits: "replace" }).add).toEqual([a]);
  });

  it("a lead that stops matching stays with a reached rule and leaves with an in rule", () => {
    expect(plan({ written: [written(a)], ruleMode: "reached" }).remove).toEqual([]);
    expect(plan({ written: [written(a)], ruleMode: "in" }).remove).toEqual(["a"]);
  });

  it("a lead deleted from LUME always leaves, whatever the rule and the edits choice", () => {
    for (const edits of ["keep", "replace"] as const)
      for (const ruleMode of ["reached", "in"] as const)
        expect(
          plan({
            desired: [a],
            written: [written(a, { editedCols: [0] })],
            edits,
            ruleMode,
            deleted: new Set(["a"]),
          }),
        ).toEqual({ add: [], update: [], remove: ["a"] });
  });

  it("a deleted lead LUME never wrote, or one a person already removed, needs no remove", () => {
    expect(plan({ deleted: new Set(["zz"]) }).remove).toEqual([]);
    expect(plan({ written: [written(a, { removedByHand: true })], deleted: new Set(["a"]) }).remove).toEqual(
      [],
    );
  });
});

describe("live sheets: the rule", () => {
  const id = "0190e0c0-0000-7000-8000-00000000abcd";
  const names = {
    stage: (x: string) => ({ q: "Qualified", w: "Won", f: "Follow-up" })[x] ?? "a stage",
    source: () => "Instagram",
    tag: () => "VIP",
    person: () => "Riya Sharma",
    team: () => "North",
  };
  const base = { includeMissing: true, includeDnc: false, backfill: true };

  it("says the rule in words", () => {
    expect(
      ruleWords({ ...base, stages: { mode: "reached", stageIds: ["q"] }, sourceIds: ["s"] }, names),
    ).toBe("Leads that reached Qualified, from Instagram");
    expect(ruleWords({ ...base, stages: { mode: "in", stageIds: ["w", "f"] }, ownerIds: ["p"] }, names)).toBe(
      "Leads in Won or Follow-up, owned by Riya Sharma",
    );
    const dated = ruleWords(
      { ...base, stages: { mode: "reached", stageIds: ["w"] }, addedOnOrAfter: "2026-11-01" },
      names,
    );
    expect(dated).toBe("Leads that reached Won, added on or after November 1, 2026");
    expect(dated).not.toMatch(/—/);
  });

  it("checks the rule's shape", () => {
    expect(
      liveSheetRuleSchema.safeParse({ ...base, stages: { mode: "reached", stageIds: [id] } }).success,
    ).toBe(true);
    expect(
      liveSheetRuleSchema.safeParse({ ...base, stages: { mode: "reached", stageIds: [] } }).success,
    ).toBe(false);
    expect(
      liveSheetRuleSchema.safeParse({ ...base, stages: { mode: "sometimes", stageIds: [id] } }).success,
    ).toBe(false);
    expect(
      liveSheetRuleSchema.safeParse({
        ...base,
        stages: { mode: "in", stageIds: [id] },
        addedOnOrAfter: "1 Nov",
      }).success,
    ).toBe(false);
  });
});

describe("live sheets: who and which plan", () => {
  it("is its own permission, which the Admin preset holds", () => {
    expect(isPermissionKey("leads.live_sheets")).toBe(true);
    expect(ALL_GRANTS).toContainEqual({ key: "leads.live_sheets", scope: null });
  });

  it("comes with Pro and up; no tier keeps it", () => {
    expect(tierAllows({ tier: "base" }, "live_sheets")).toBe(false);
    expect(tierAllows({ tier: "pro" }, "live_sheets")).toBe(true);
    expect(tierAllows({ tier: "enterprise" }, "live_sheets")).toBe(true);
    expect(tierAllows({ tier: null }, "live_sheets")).toBe(true);
    expect(tierFor("live_sheets")).toBe("pro");
    expect(TIER_LINES.pro).toContain("Live sheets for Meta audiences");
  });
});
