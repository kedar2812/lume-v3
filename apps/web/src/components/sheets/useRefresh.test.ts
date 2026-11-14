import { describe, expect, it } from "vitest";
import type { RefreshProgress } from "@/lib/sheets/types";
import { resultLine } from "./useRefresh";

const p = (over: Partial<RefreshProgress> = {}): RefreshProgress => ({
  status: "done",
  rowsRead: 0,
  rowsTotal: 0,
  created: 0,
  merged: 0,
  leadIds: [],
  unreachable: false,
  retryInS: null,
  attention: [],
  ...over,
});

describe("Refresh's result line, with live sheets (2026-11-14)", () => {
  it("says the live sheets it updated, beside what came in", () => {
    expect(resultLine(p({ liveSheets: { total: 2, done: 2 } }), null, false)).toBe(
      "Up to date · 2 live sheets updated",
    );
    expect(resultLine(p({ created: 3, liveSheets: { total: 1, done: 1 } }), null, false)).toBe(
      "3 new leads · 1 live sheet updated",
    );
  });

  it("only live sheets, still going: said as that", () => {
    expect(resultLine(p({ status: "running", liveSheets: { total: 2, done: 0 } }), null, false)).toBe(
      "Updating your live sheets.",
    );
  });

  it("an older API without live sheets reads as before", () => {
    expect(resultLine(p(), null, false)).toBe("Up to date");
  });
});
