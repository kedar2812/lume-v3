import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  apiQuery,
  filtersToParams,
  parseFilters,
  type ListFilters,
} from "./filters";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();
const [s1, s2] = cat.pipelines[0]!.stages;

describe("lead filters in the URL", () => {
  it("round-trips every filter through the address bar", () => {
    const f: ListFilters = {
      ...EMPTY_FILTERS,
      q: "aisha",
      stageIds: [s1!.id, s2!.id],
      owner: "me",
      tagId: cat.tags[0]!.id,
      phoneStatus: "needs_country",
      from: "2026-09-01",
      to: "2026-09-30",
      sort: "updated",
    };
    expect(parseFilters(filtersToParams(f), cat)).toEqual(f);
  });

  it("drops anything it can't vouch for, instead of breaking the page", () => {
    const junk = new URLSearchParams({
      stage: `${s1!.id},not-a-stage,${"0".repeat(36)}`,
      owner: "someone-deleted",
      tag: "nope",
      phone: "weird",
      from: "2026-13-45",
      to: "yesterday",
      sort: "chaos",
      pipeline: "gone",
      cursor: "should-never-be-trusted",
    });
    expect(parseFilters(junk, cat)).toEqual({ ...EMPTY_FILTERS, stageIds: [s1!.id] });
  });

  it("builds the API query, never with a cursor", () => {
    const q = new URLSearchParams(
      apiQuery({ ...EMPTY_FILTERS, stageIds: [s1!.id], owner: "none", q: "  riya  " }),
    );
    expect(q.get("ownerId")).toBe("none");
    expect(q.get("q")).toBe("riya");
    expect(q.get("stageId")).toBe(s1!.id);
    expect(q.has("cursor")).toBe(false);
  });

  it("counts what the person has narrowed, so the bar can say so", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "x", stageIds: [s1!.id, s2!.id], owner: "me" })).toBe(3);
  });
});
