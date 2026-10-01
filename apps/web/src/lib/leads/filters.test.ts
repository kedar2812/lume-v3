import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  apiQuery,
  filtersToParams,
  parseFilters,
  toViewFilters,
  fromViewFilters,
  type ListFilters,
} from "./filters";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();
const [s1, s2] = cat.pipelines[0]!.stages;

describe("lead filters in the URL", () => {
  it("arrivedAfter goes to the API, not into the address bar", () => {
    const f = { stageIds: [], sort: "newest" as const, arrivedAfter: "2026-09-26T18:00:00.000Z" };
    expect(apiQuery(f)).toContain("arrivedAfter=2026-09-26T18%3A00%3A00.000Z");
    expect(filtersToParams(f).has("arrivedAfter")).toBe(false);
  });

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
      source: "0190e0c0-0000-7000-8000-00000000c5c5",
    };
    expect(parseFilters(filtersToParams(f), cat)).toEqual(f);
  });

  it("4B: what's gone quiet round-trips through the address bar, and reaches the API by its own names", () => {
    const f: ListFilters = {
      ...EMPTY_FILTERS,
      noReplyDays: 3,
      lostDaysAgo: 30,
      lostReasonId: "r-price",
      followUpOverdue: true,
      createdDays: 1,
    };
    const url = filtersToParams(f);
    expect(url.toString()).toBe("noreply=3&lost=30&reason=r-price&overdue=1&new=1");
    expect(parseFilters(url, cat)).toEqual(f);
    const api = new URLSearchParams(apiQuery(f));
    expect(Object.fromEntries(api)).toMatchObject({
      noReplyDays: "3",
      lostDaysAgo: "30",
      lostReasonId: "r-price",
      followUpOverdue: "true",
      createdDays: "1",
    });
    expect(activeFilterCount(f)).toBe(5);
  });

  it("4B: a saved view keeps the list's API filters, and opens as the same filters", () => {
    const f: ListFilters = {
      ...EMPTY_FILTERS,
      q: "aisha",
      stageIds: [s1!.id],
      owner: "me",
      tagId: cat.tags[0]!.id,
      from: "2026-09-01",
      sort: "updated",
      noReplyDays: 3,
      lostDaysAgo: 30,
      lostReasonId: "r-price",
      followUpOverdue: true,
      createdDays: 7,
      custom: { struggles: "o1" },
    };
    const saved = toViewFilters(f);
    expect(saved).toMatchObject({
      stageId: s1!.id,
      ownerId: "me",
      noReplyDays: "3",
      followUpOverdue: "true",
    });
    expect(fromViewFilters(saved, cat)).toEqual(f);
    // A view naming a stage that's gone opens without it, rather than breaking the page (Review Focus 2).
    expect(fromViewFilters({ stageId: "0".repeat(36), noReplyDays: "3" }, cat)).toEqual({
      ...EMPTY_FILTERS,
      noReplyDays: 3,
    });
  });

  it("4B: any quiet value the API would take opens as it counts (not only the menu's)", () => {
    const f = parseFilters(new URLSearchParams({ noreply: "5", lost: "45", new: "30" }), cat);
    expect(f).toMatchObject({ noReplyDays: 5, lostDaysAgo: 45, createdDays: 30 });
  });

  it("4B: a quiet filter it can't vouch for is dropped", () => {
    const junk = new URLSearchParams({
      noreply: "0",
      lost: "abc",
      reason: "r-gone",
      overdue: "yes",
      new: "999",
    });
    expect(parseFilters(junk, cat)).toEqual(EMPTY_FILTERS);
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
      source: "not-a-source",
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
    const src = "0190e0c0-0000-7000-8000-00000000c5c5";
    expect(new URLSearchParams(apiQuery({ ...EMPTY_FILTERS, source: src })).get("source")).toBe(src);
    expect(activeFilterCount({ ...EMPTY_FILTERS, source: src })).toBe(1);
  });

  it("counts what the person has narrowed, so the bar can say so", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: "x", stageIds: [s1!.id, s2!.id], owner: "me" })).toBe(3);
  });

  it("carries custom-field filters, dropping fields and options that no longer exist", () => {
    const params = new URLSearchParams("cf.struggles=o1&cf.handled_by=u-riya&cf.gone=x&cf.struggles2=o9");
    const f = parseFilters(params, cat);
    expect(f.custom).toEqual({ struggles: "o1", handled_by: "u-riya" });
    expect(parseFilters(filtersToParams(f), cat)).toEqual(f);
    expect(parseFilters(new URLSearchParams("cf.struggles=deleted-option"), cat).custom).toBeUndefined();
    expect(new URLSearchParams(apiQuery(f)).get("custom")).toBe(
      JSON.stringify({ struggles: "o1", handled_by: "u-riya" }),
    );
    expect(activeFilterCount(f)).toBe(2);
  });
});
