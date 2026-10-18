import { describe, expect, it } from "vitest";
import type { NextStep } from "../../packages/core/src/index";
import {
  factsFor,
  idOf,
  NOW,
  scoreNextStep,
  summarize,
  ungrounded,
  type Businesses,
  type NextStepCase,
} from "./score";

/** The eval's scoring (plan 2026-10-18 Task 11): what counts as right, per field, without a model. */
const businesses: Businesses = {
  shop: {
    timezone: "Asia/Kolkata",
    stages: [
      { key: "new", name: "New", kind: "open" },
      { key: "visit", name: "Visit booked", kind: "open" },
      { key: "won", name: "Won", kind: "won" },
      { key: "lost", name: "Lost", kind: "lost" },
    ],
    lostReasons: [
      { key: "price", label: "Price" },
      { key: "timing", label: "Not now" },
    ],
    tags: [{ key: "hot", label: "hot" }],
  },
};
const base: NextStepCase = {
  id: "t1",
  business: "shop",
  firstName: "Sneha",
  stage: "new",
  note: "Visit Saturday 11 am.",
  expect: { stage: "visit", followUp: { on: ["2026-10-24"], at: "11:00" }, tags: [] },
};
const answer = (over: Partial<NextStep> = {}): NextStep => ({
  summary: "Wants a visit.",
  stageId: idOf("shop", "visit"),
  followUp: { at: "2026-10-24T11:00", title: "Visit" },
  lostReasonId: null,
  tagIds: [],
  decisionMaker: null,
  ...over,
});
const score = (c: NextStepCase, raw: NextStep) => scoreNextStep(c, raw, factsFor(c, businesses));

describe("the facts a case becomes", () => {
  it("ids are real-looking UUIDs, the same every run, and 'now' is the eval's fixed moment", () => {
    const { facts } = factsFor(base, businesses);
    expect(facts.stage.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(facts.stage.id).toBe(idOf("shop", "new"));
    expect(facts.now).toBe(NOW);
    expect(facts.stages.map((s) => s.name)).toEqual(["New", "Visit booked", "Won", "Lost"]);
  });
});

describe("scoring a next step", () => {
  it("all right", () => {
    expect(score(base, answer())).toMatchObject({
      stage: true,
      followUp: true,
      lostReason: true,
      tags: true,
      past: false,
      invented: 0,
    });
  });

  it("staying put may be said as null or as the current stage", () => {
    const c = { ...base, expect: { ...base.expect, stage: null } };
    expect(score(c, answer({ stageId: null })).stage).toBe(true);
    expect(score(c, answer({ stageId: idOf("shop", "new") })).stage).toBe(true);
    expect(score(c, answer()).stage).toBe(false);
  });

  it("a follow-up: the right day, at the time the note named; a range; 'any'; none", () => {
    expect(score(base, answer({ followUp: { at: "2026-10-24T10:00", title: "x" } })).followUp).toBe(false);
    expect(score(base, answer({ followUp: { at: "2026-10-25T11:00", title: "x" } })).followUp).toBe(false);
    const range = {
      ...base,
      expect: { ...base.expect, followUp: { between: ["2026-11-09", "2026-11-16"] as [string, string] } },
    };
    expect(score(range, answer({ followUp: { at: "2026-11-10T10:00", title: "x" } })).followUp).toBe(true);
    expect(score(range, answer({ followUp: null })).followUp).toBe(false);
    const any = { ...base, expect: { ...base.expect, followUp: "any" as const } };
    expect(score(any, answer({ followUp: null })).followUp).toBe(true);
    const none = { ...base, expect: { ...base.expect, followUp: null } };
    expect(score(none, answer()).followUp).toBe(false);
  });

  it("a lost reason counts only with the lost stage, and no reason otherwise", () => {
    const lost = { ...base, expect: { stage: "lost", lostReason: ["price"], followUp: null, tags: [] } };
    expect(
      score(
        lost,
        answer({ stageId: idOf("shop", "lost"), lostReasonId: idOf("shop", "price"), followUp: null }),
      ),
    ).toMatchObject({ stage: true, lostReason: true });
    expect(
      score(
        lost,
        answer({ stageId: idOf("shop", "lost"), lostReasonId: idOf("shop", "timing"), followUp: null }),
      ).lostReason,
    ).toBe(false);
  });

  it("tags: the exact set, or one of the sets allowed", () => {
    expect(score(base, answer({ tagIds: [idOf("shop", "hot")] })).tags).toBe(false);
    const either = { ...base, expect: { ...base.expect, tags: [["hot"], []] } };
    expect(score(either, answer({ tagIds: [idOf("shop", "hot")] })).tags).toBe(true);
    expect(score(either, answer()).tags).toBe(true);
  });

  it("ids the business doesn't have are counted before the cleaner, and none survive it", () => {
    const r = score(base, answer({ stageId: "made-up", tagIds: ["also-made-up"] }));
    expect(r.invented).toBe(2);
    expect(r.cleaned.stageId).toBeNull();
    expect(r.cleaned.tagIds).toEqual([]);
  });

  it("a follow-up in the past never survives the cleaner", () => {
    const r = score(base, answer({ followUp: { at: "2026-10-20T11:00", title: "x" } }));
    expect(r.cleaned.followUp).toBeNull();
    expect(r.past).toBe(false);
  });
});

describe("the summary", () => {
  it("each field as a share of the cases, and whether it passes LUME's marks", () => {
    const right = score(base, answer());
    const wrong = score(base, answer({ stageId: null, followUp: null }));
    const s = summarize(Array.from({ length: 9 }, () => right).concat([wrong]));
    expect(s).toMatchObject({ cases: 10, stage: 0.9, followUp: 0.9, past: 0, inventedAfter: 0, pass: true });
    expect(summarize([right, wrong]).pass).toBe(false);
  });
});

describe("a catch-up line's grounding", () => {
  it("a number the history doesn't have is flagged", () => {
    const history = "Quote sent, 7.8 lakh. Site visit on the 12th.";
    expect(ungrounded(["The quote was 7.8 lakh.", "The visit was on the 12th."], history)).toEqual([]);
    expect(ungrounded(["The quote was 8 lakh.", "Call on the 3rd."], history)).toEqual(["8", "3"]);
  });
});
