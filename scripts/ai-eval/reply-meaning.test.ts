import { describe, expect, it } from "vitest";
import type { ReplyMeaning } from "../../packages/core/src/index";
import { MEANING_MARKS, meaningCtx, scoreMeaning, summarizeMeaning, type MeaningCase } from "./reply-meaning";
import { idOf, type Businesses } from "./score";

/** The reply-meaning eval (W2; spec 2026-10-18 §6.4): each reply as LUME would ask, cleaned, scored. */
const businesses: Businesses = {
  interiors: {
    timezone: "Asia/Kolkata",
    stages: [
      { key: "new", name: "New enquiry", kind: "open" },
      { key: "visit", name: "Site visit booked", kind: "open" },
      { key: "lost", name: "Lost", kind: "lost" },
    ],
    lostReasons: [{ key: "price", label: "Too expensive" }],
    tags: [],
  },
};
const c: MeaningCase = {
  id: "t1",
  business: "interiors",
  firstName: "Sneha",
  stage: "new",
  thread: [{ from: "business", minsAgo: 60, text: "Would you like a free site visit?" }],
  reply: "Yes, Saturday 11 am works",
  expect: {
    group: ["visit_or_call", "interested"],
    stage: ["visit", null],
    followUp: { on: ["2026-10-24"] },
  },
};
const out = (o: Partial<ReplyMeaning> = {}): ReplyMeaning => ({
  meaning: "visit_or_call",
  summary: "Saturday 11 works.",
  stop: false,
  stageId: idOf("interiors", "visit"),
  followUp: { at: "2026-10-24T11:00", title: "Site visit" },
  lostReasonId: null,
  ...o,
});

describe("a reply against its case", () => {
  it("the group, the stage and the day it should follow up on", () => {
    const s = scoreMeaning(c, out(), meaningCtx(c, businesses));
    expect(s).toMatchObject({ group: true, stage: true, followUp: true, stopMissed: false, invented: 0 });
    const wrong = scoreMeaning(
      c,
      out({ meaning: "later", followUp: { at: "2026-10-25T11:00", title: "x" } }),
      meaningCtx(c, businesses),
    );
    expect(wrong).toMatchObject({ group: false, followUp: false });
  });

  it("a stop missed is the miss that never may happen; an invented id is counted and cleaned", () => {
    const stop: MeaningCase = { ...c, reply: "Aage se likhna mat", expect: { group: "stop", stop: true } };
    expect(scoreMeaning(stop, out(), meaningCtx(stop, businesses)).stopMissed).toBe(true);
    expect(
      scoreMeaning(stop, out({ meaning: "stop", stop: true }), meaningCtx(stop, businesses)).stopMissed,
    ).toBe(false);
    expect(scoreMeaning(c, out({ stageId: "made-up" }), meaningCtx(c, businesses)).invented).toBe(1);
  });
});

describe("the marks", () => {
  it("the group at 85%, every stop caught, nothing invented after cleaning", () => {
    const ok = { group: true, stopMissed: false, inventedAfter: 0 };
    const many = (n: number, o = {}) => Array.from({ length: n }, () => ({ ...ok, ...o }));
    expect(summarizeMeaning([...many(17), ...many(3, { group: false })]).pass).toBe(true);
    expect(summarizeMeaning([...many(16), ...many(4, { group: false })]).pass).toBe(false);
    expect(summarizeMeaning([...many(19), ...many(1, { stopMissed: true })]).pass).toBe(false);
    expect(MEANING_MARKS).toEqual({ group: 0.85 });
  });
});
