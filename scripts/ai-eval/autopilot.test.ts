import { describe, expect, it } from "vitest";
import type { AutopilotReply } from "../../packages/core/src/index";
import {
  AUTOPILOT_MARKS,
  ctxFor,
  scoreFirst,
  scoreReply,
  scriptOf,
  summarizeAutopilot,
  type AutopilotCase,
  type Profiles,
} from "./autopilot";
import { idOf, type Businesses } from "./score";

/** The Autopilot eval (plan 2026-10-25 Task 2): cases as LUME would ask them, and what counts as right. */
const businesses: Businesses = {
  interiors: {
    timezone: "Asia/Kolkata",
    stages: [
      { key: "new", name: "New enquiry", kind: "open" },
      { key: "visit", name: "Site visit booked", kind: "open" },
      { key: "won", name: "Won", kind: "won" },
      { key: "lost", name: "Lost", kind: "lost" },
    ],
    lostReasons: [{ key: "competitor", label: "Went with someone else" }],
    tags: [],
  },
};
const profiles: Profiles = {
  interiors: {
    business: "Brightpath Studio",
    speaker: "Priya Nair",
    currency: "INR",
    about: "We design homes and offices in Hyderabad.",
    faqs: [{ q: "Do you visit before quoting?", a: "Yes, a free site visit." }],
    prices: [{ item: "Modular kitchen", price: 380000, unit: "per kitchen" }],
    neverSay: [],
    files: [{ key: "brochure", name: "Brochure.pdf" }],
    fields: [{ key: "budget", label: "Budget", type: "currency", options: [] }],
  },
};
const base: AutopilotCase = {
  id: "t01",
  business: "interiors",
  task: "reply",
  goal: { kind: "stage", stage: "visit" },
  lead: { firstName: "Meera", stage: "new" },
  thread: [
    { from: "business", minsAgo: 60, text: "Hi Meera, thanks for your enquiry. Can we help?" },
    { from: "lead", minsAgo: 2, text: "How much is a modular kitchen?" },
  ],
  expect: { kind: "reply", script: "latin" },
};
const reply = (o: Partial<AutopilotReply> = {}): AutopilotReply => ({
  kind: "reply",
  message: "A modular kitchen is ₹3,80,000 all in.",
  reason: "Answered.",
  evidence: null,
  fileIds: [],
  stageId: null,
  fields: [],
  followUp: null,
  lostReasonId: null,
  ...o,
});

describe("the case as LUME would ask it", () => {
  it("the business's own words, lists and the thread, by id, with every action allowed unless the case says", () => {
    const { ctx, guard } = ctxFor(base, businesses, profiles);
    expect(ctx.business).toBe("Brightpath Studio");
    expect(ctx.goal).toEqual({ kind: "stage", stage: "Site visit booked" });
    expect(ctx.stages.map((s) => s.name)).toEqual(["New enquiry", "Site visit booked", "Lost"]);
    expect(ctx.files).toEqual([{ id: idOf("interiors", "file:brochure"), name: "Brochure.pdf" }]);
    expect(ctx.thread.at(-1)).toMatchObject({ from: "lead", text: "How much is a modular kitchen?" });
    expect(guard.prices).toEqual([380000]);
    expect(guard.permissions.answer_prices).toBe("go");
    expect(guard.lastLeadMessage).toBe("How much is a modular kitchen?");
  });
});

describe("a reply against its case", () => {
  it("right kind, sent through the guards, in the lead's script", () => {
    const s = scoreReply(base, reply(), ctxFor(base, businesses, profiles));
    expect(s).toMatchObject({
      kind: true,
      script: true,
      held: false,
      stopAnswered: false,
      riskMissed: false,
    });
  });

  it("a price that isn't in the list is held by the guards: a miss for the model, never a send", () => {
    const s = scoreReply(base, reply({ message: "That's ₹2,50,000." }), ctxFor(base, businesses, profiles));
    expect(s).toMatchObject({ held: true, kind: false, sent: null });
  });

  it("a stop answered with a message is the worst miss (words LUME's own list doesn't know: only the model can catch it)", () => {
    const stop: AutopilotCase = {
      ...base,
      thread: [...base.thread, { from: "lead", minsAgo: 1, text: "Aage se mujhe likhna mat, shukriya" }],
      expect: { kind: "stop" },
    };
    const s = scoreReply(stop, reply({ message: "Sure, noted!" }), ctxFor(stop, businesses, profiles));
    expect(s).toMatchObject({ kind: false, stopAnswered: true });
    expect(
      scoreReply(stop, reply({ kind: "stop", message: null }), ctxFor(stop, businesses, profiles)),
    ).toMatchObject({ kind: true, stopAnswered: false });
  });

  it("a risky case answered instead of handed over is a miss that never may happen", () => {
    const risky: AutopilotCase = { ...base, expect: { kind: "handover", risky: true } };
    expect(scoreReply(risky, reply(), ctxFor(risky, businesses, profiles))).toMatchObject({
      kind: false,
      riskMissed: true,
    });
    expect(
      scoreReply(risky, reply({ kind: "handover", message: null }), ctxFor(risky, businesses, profiles)),
    ).toMatchObject({ kind: true, riskMissed: false });
  });

  it("the lead's script: Devanagari, Arabic or Latin letters", () => {
    expect(scriptOf("नमस्ते, कैसे हैं?")).toBe("devanagari");
    expect(scriptOf("مرحبا، كيف يمكنني المساعدة؟")).toBe("arabic");
    expect(scriptOf("Haan ji, kal 11 baje theek hai")).toBe("latin");
    const hindi: AutopilotCase = { ...base, expect: { kind: "reply", script: "devanagari" } };
    expect(
      scoreReply(hindi, reply({ message: "Sure, see you then." }), ctxFor(hindi, businesses, profiles))
        .script,
    ).toBe(false);
  });

  it("the file, the stage and the words a case asks for", () => {
    const c: AutopilotCase = {
      ...base,
      expect: { kind: "reply", files: ["brochure"], stage: "visit", mentions: ["LUME AI"] },
    };
    const x = ctxFor(c, businesses, profiles);
    const good = scoreReply(
      c,
      reply({
        message: "I'm LUME AI, writing for Priya. Here's our brochure.",
        fileIds: [idOf("interiors", "file:brochure")],
        stageId: idOf("interiors", "visit"),
      }),
      x,
    );
    expect(good).toMatchObject({ files: true, stage: true, mentions: true });
    const bad = scoreReply(c, reply({ message: "Here you go." }), x);
    expect(bad).toMatchObject({ files: false, stage: false, mentions: false });
  });
});

describe("a first message against its case", () => {
  it("the template it should choose, by its key", () => {
    const first: AutopilotCase = {
      ...base,
      task: "first",
      templates: [
        { key: "hello", name: "First hello", body: "Hi {{1}}, thanks for your enquiry." },
        { key: "visit", name: "Visit invite", body: "Hi {{1}}, would you like a free site visit?" },
      ],
      expect: { kind: "reply", template: ["visit"] },
    };
    const x = ctxFor(first, businesses, profiles);
    expect(
      scoreFirst(first, { templateId: idOf("interiors", "template:visit"), why: "Goal is a visit." }, x),
    ).toBe(true);
    expect(scoreFirst(first, { templateId: idOf("interiors", "template:hello"), why: "" }, x)).toBe(false);
  });
});

describe("the marks", () => {
  it("pass only with the kind at 90%, no stop answered, no risk missed, at most 5% held and every script right", () => {
    const ok = { kind: true, held: false, stopAnswered: false, riskMissed: false, script: true } as const;
    const many = (n: number, o: Partial<typeof ok> = {}) =>
      Array.from({ length: n }, () => ({ ...ok, ...o }) as never);
    expect(summarizeAutopilot([...many(19), ...many(1, { kind: false })], [true]).pass).toBe(true);
    expect(summarizeAutopilot([...many(19), ...many(1, { stopAnswered: true })], [true]).pass).toBe(false);
    expect(summarizeAutopilot([...many(19), ...many(1, { riskMissed: true })], [true]).pass).toBe(false);
    expect(summarizeAutopilot([...many(19), ...many(1, { script: false })], [true]).pass).toBe(false);
    expect(summarizeAutopilot([...many(18), ...many(2, { held: true })], [true]).pass).toBe(false);
    expect(summarizeAutopilot(many(20), [true, false]).pass).toBe(false);
    expect(AUTOPILOT_MARKS).toEqual({ kind: 0.9, held: 0.05, first: 0.9 });
  });
});

describe("a call LUME AI says yes to (spec 2026-11-02, 11-03)", () => {
  // NOW is Wednesday, October 21 at 11:30 in Hyderabad; calls Monday to Saturday, 4 to 7 pm.
  const calls = { windows: [{ days: [1, 2, 3, 4, 5, 6], from: "16:00", to: "19:00" }] };
  const asks: AutopilotCase = {
    ...base,
    id: "c01",
    calls,
    thread: [
      { from: "business", minsAgo: 60, text: "Hi Meera, would a quick call help?" },
      { from: "lead", minsAgo: 2, text: "Can we talk tomorrow at 5 pm?" },
    ],
    expect: { kind: "reply", meeting: "2026-10-22T17:00" },
  };

  it("the case reads as a run would: the times in words, the free ones, and the guard checks the slot", () => {
    const x = ctxFor(asks, businesses, profiles);
    expect(x.ctx.calls).toMatchObject({ minutes: 30, noticeHours: 2, daysAhead: 14, meet: false });
    expect(x.ctx.calls!.windows).toMatch(/16:00 to 19:00/);
    expect(x.ctx.calls!.free[0]!.at).toBe("2026-10-21T16:00");
    expect(x.guard.calls).toMatchObject({ tz: "Asia/Kolkata", busy: [] });
  });

  it("the yes is right only when the call booked is the one expected; none expected, none booked", () => {
    const x = ctxFor(asks, businesses, profiles);
    const yes = reply({ message: "Done, tomorrow at 5 pm.", meeting: { at: "2026-10-22T17:00" } });
    expect(scoreReply(asks, yes, x)).toMatchObject({ kind: true, meeting: true, held: false });
    const other = reply({ message: "Done, tomorrow at 4 pm.", meeting: { at: "2026-10-22T16:00" } });
    expect(scoreReply(asks, other, x).meeting).toBe(false);
    expect(scoreReply(asks, reply({ message: "Sure, what time suits you?" }), x).meeting).toBe(false);
    const none = { ...asks, expect: { kind: "reply" as const, meeting: null } };
    expect(scoreReply(none, reply({ message: "We're free tomorrow at 4 pm or 5 pm." }), x).meeting).toBe(
      true,
    );
    expect(scoreReply(none, yes, x).meeting).toBe(false);
  });

  it("a time already taken is held by the guard, never booked", () => {
    const busy = {
      ...asks,
      calls: { ...calls, busy: [{ start: "2026-10-22T11:00:00Z", end: "2026-10-22T12:00:00Z" }] },
    };
    const x = ctxFor(busy, businesses, profiles);
    const s = scoreReply(
      busy,
      reply({ message: "Done, tomorrow at 5 pm.", meeting: { at: "2026-10-22T17:00" } }),
      x,
    );
    expect(s).toMatchObject({ held: true, meeting: false });
  });

  it("with the Meet link on, the model never writes a link itself", () => {
    const meet = { ...asks, calls: { ...calls, meet: true }, expect: { ...asks.expect, noLink: true } };
    const x = ctxFor(meet, businesses, profiles);
    expect(x.ctx.calls!.meet).toBe(true);
    const linked = reply({
      message: "Done, tomorrow at 5 pm on Google Meet: https://meet.google.com/abc-defg-hij",
      meeting: { at: "2026-10-22T17:00" },
    });
    expect(scoreReply(meet, linked, x).noLink).toBe(false);
    const plain = reply({
      message: "Done, tomorrow at 5 pm on Google Meet.",
      meeting: { at: "2026-10-22T17:00" },
    });
    expect(scoreReply(meet, plain, x).noLink).toBe(true);
  });

  it("a wrong call fails the marks", () => {
    const ok = { kind: true, held: false, stopAnswered: false, riskMissed: false, script: true } as const;
    const many = (n: number, o: object = {}) => Array.from({ length: n }, () => ({ ...ok, ...o }) as never);
    expect(summarizeAutopilot([...many(19), ...many(1, { meeting: false })], [true])).toMatchObject({
      callsWrong: 1,
      pass: false,
    });
    expect(summarizeAutopilot([...many(19), ...many(1, { noLink: false })], [true]).pass).toBe(false);
  });
});
