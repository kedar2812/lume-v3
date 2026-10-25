import { describe, expect, it } from "vitest";
import { AUTOPILOT_PRESETS, DEFAULT_AI_PROFILE, mergeAiProfile } from "./profile";
import {
  AUTOPILOT_ACTION_TITLES,
  autopilotInput,
  autopilotInstructions,
  autopilotReplyOutput,
  guardFirst,
  guardReply,
  timesIn,
  type AutopilotCtx,
  type GuardCtx,
} from "./autopilot-tasks";

/** What LUME AI is asked in a run, and the guards on every answer (Autopilot spec 2026-10-19 §1.3, §3, §11). */
const STAGE_OPEN = "0192c000-0000-7000-8000-000000000001";
const STAGE_GOAL = "0192c000-0000-7000-8000-000000000002";
const STAGE_LOST = "0192c000-0000-7000-8000-000000000003";
const REASON = "0192c000-0000-7000-8000-000000000004";
const FILE = "0192c000-0000-7000-8000-000000000005";
const OTHER_FILE = "0192c000-0000-7000-8000-000000000006";
const TEMPLATE = "0192c000-0000-7000-8000-000000000007";

const profile = mergeAiProfile(null, {
  knows: {
    about: "Brightpath designs homes and offices in the city.",
    faqs: [{ q: "Do you visit before quoting?", a: "Yes, a free site visit." }],
    prices: [
      {
        id: "0192c000-0000-7000-8000-000000000010",
        item: "Modular kitchen",
        price: 380000,
        unit: "per kitchen",
        notes: "",
      },
    ],
    neverSay: ["We never promise a finish date before the site visit"],
  },
  voice: { tone: "warm", signOff: "Team Brightpath" },
});
const ctx = (o: Partial<AutopilotCtx> = {}): AutopilotCtx => ({
  business: "Brightpath Studio",
  speaker: "Priya Nair",
  goal: { kind: "stage", stage: "Site visit booked" },
  profile,
  currency: "INR",
  lead: { firstName: "Meera", stage: "Contacted", fields: [{ label: "Budget", value: "₹10–20 lakh" }] },
  thread: [{ from: "lead", at: "2026-10-22T10:00:00Z", text: "Hi, what does a kitchen cost?" }],
  templates: [{ id: TEMPLATE, name: "First hello", body: "Hi {{first_name}}, thanks for your enquiry." }],
  files: [{ id: FILE, name: "Brochure.pdf" }],
  stages: [
    { id: STAGE_OPEN, name: "Contacted", kind: "open" },
    { id: STAGE_GOAL, name: "Site visit booked", kind: "open" },
    { id: STAGE_LOST, name: "Lost", kind: "lost" },
  ],
  lostReasons: [{ id: REASON, label: "Too expensive" }],
  fillable: [
    { key: "property_type", label: "Property type", type: "select", options: ["Apartment", "Villa"] },
    { key: "move_in", label: "Move-in date", type: "date", options: [] },
  ],
  now: "2026-10-22T10:05:00Z",
  timezone: "Asia/Kolkata",
  ...o,
});
const guard = (o: Partial<GuardCtx> = {}): GuardCtx => ({
  prices: [380000],
  fileIds: [FILE],
  lastLeadMessage: "Hi, what does a kitchen cost?",
  leadWords: "Hi, what does a kitchen cost?",
  permissions: AUTOPILOT_PRESETS.hands_off,
  openStageIds: [STAGE_OPEN, STAGE_GOAL],
  lostStageIds: [STAGE_LOST],
  lostReasonIds: [REASON],
  fieldKeys: ["budget"],
  ...o,
});
const reply = (o: Partial<ReturnType<typeof autopilotReplyOutput.parse>> = {}) =>
  autopilotReplyOutput.parse({
    kind: "reply",
    message: "A modular kitchen is ₹3,80,000 all in.",
    reason: "Answered the price question.",
    evidence: null,
    fileIds: [],
    stageId: null,
    fields: {},
    followUp: null,
    lostReasonId: null,
    ...o,
  });

describe("what LUME AI is asked", () => {
  it("the instructions carry the business's own words and never offer denying it's AI", () => {
    const say = autopilotInstructions("autopilot_reply", ctx());
    for (const words of [
      "Brightpath designs homes and offices in the city.",
      "Do you visit before quoting?",
      "Modular kitchen",
      "380000",
      "We never promise a finish date before the site visit",
      "Priya Nair",
      "Brightpath Studio",
      "Site visit booked",
      "Team Brightpath",
    ])
      expect(say, words).toContain(words);
    expect(say).toContain("say honestly that you are LUME AI");
    expect(say.toLowerCase()).not.toMatch(/pretend|deny being|you are a human/);
    const handOver = autopilotInstructions(
      "autopilot_reply",
      ctx({ profile: mergeAiProfile(profile, { standing: { botQuestion: "hand_over" } }) }),
    );
    expect(handOver).toContain("whether they are talking to a bot or AI, answer with kind handover");
  });

  it("the input is the lead's thread and the business's lists, never a phone or an email", () => {
    const input = JSON.parse(autopilotInput("autopilot_first", ctx()));
    expect(input.templates[0].id).toBe(TEMPLATE);
    expect(input.lead.firstName).toBe("Meera");
    expect(JSON.stringify(input)).not.toMatch(/@|\+\d{6,}/);
  });
});

describe("what a reply may change", () => {
  it("the reply's input names the stages, the lost reasons and the empty fields it may fill, by id and key", () => {
    const input = JSON.parse(autopilotInput("autopilot_reply", ctx()));
    expect(input.stages).toEqual([
      { id: STAGE_OPEN, name: "Contacted", kind: "open" },
      { id: STAGE_GOAL, name: "Site visit booked", kind: "open" },
      { id: STAGE_LOST, name: "Lost", kind: "lost" },
    ]);
    expect(input.lostReasons).toEqual([{ id: REASON, label: "Too expensive" }]);
    expect(input.fillable).toEqual([
      { key: "property_type", label: "Property type", type: "select", options: ["Apartment", "Villa"] },
      { key: "move_in", label: "Move-in date", type: "date", options: [] },
    ]);
    // A first message only chooses a template: nothing to change.
    const first = JSON.parse(autopilotInput("autopilot_first", ctx()));
    expect(first.stages).toBeUndefined();
    expect(first.fillable).toBeUndefined();
  });

  it("the instructions say how: stages and reasons by id, fields by key, a choice by one of its options", () => {
    const say = autopilotInstructions("autopilot_reply", ctx());
    expect(say).toContain("set stageId to one of the stages given by id");
    expect(say).toContain("a lostReasonId from the lost reasons given");
    expect(say).toContain("fill only the empty fields given, by key");
  });
});

describe("guards hold", () => {
  it("a backed price goes; an unbacked one never does", () => {
    expect(guardReply(reply(), guard())).toMatchObject({
      kind: "send",
      message: "A modular kitchen is ₹3,80,000 all in.",
    });
    expect(guardReply(reply({ message: "Sure, ₹15,000 for the design." }), guard())).toEqual({
      kind: "handover",
      reason: "LUME AI wanted to quote a price that isn't in your price list.",
      evidence: null,
    });
  });

  it("a file nobody chose is dropped; a chosen one goes", () => {
    const g = guardReply(reply({ message: "Here's our brochure.", fileIds: [FILE, OTHER_FILE] }), guard());
    expect(g).toMatchObject({ kind: "send", fileIds: [FILE] });
  });

  it("a time the lead didn't name is never offered; one they named may be confirmed", () => {
    expect(guardReply(reply({ message: "Shall we say Saturday 4 pm?" }), guard())).toEqual({
      kind: "handover",
      reason: "LUME AI wanted to offer a time you haven't given it.",
      evidence: null,
    });
    const named = guard({
      leadWords: "Saturday 4 pm works for me",
      lastLeadMessage: "Saturday 4 pm works for me",
    });
    expect(guardReply(reply({ message: "Lovely, Saturday 4 pm it is." }), named)).toMatchObject({
      kind: "send",
    });
    expect(timesIn("See you tomorrow at 10:30 am, or on 24th Oct")).toEqual([
      "tomorrow",
      "10:30 am",
      "24th",
      "oct",
    ]);
  });

  it("an action set to Never hands over, naming it; one set to Ask me waits for a tap", () => {
    const never = { ...AUTOPILOT_PRESETS.balanced, replies: "never" as const };
    expect(guardReply(reply(), guard({ permissions: never }))).toEqual({
      kind: "handover",
      reason: `"${AUTOPILOT_ACTION_TITLES.replies}" is set to Never.`,
      evidence: null,
    });
    const lost = reply({ message: "Understood, all the best.", stageId: STAGE_LOST, lostReasonId: REASON });
    expect(guardReply(lost, guard({ permissions: AUTOPILOT_PRESETS.balanced }))).toMatchObject({
      kind: "ask",
      action: "mark_lost",
      updates: { stageId: STAGE_LOST, lostReasonId: REASON },
    });
    // Prices are asked about in Balanced: an answer naming one waits for a tap.
    expect(
      guardReply(reply(), guard({ permissions: { ...AUTOPILOT_PRESETS.balanced, answer_prices: "ask" } })),
    ).toMatchObject({
      kind: "ask",
      action: "answer_prices",
    });
  });

  it("the lead's stop beats the model", () => {
    expect(guardReply(reply(), guard({ lastLeadMessage: "please don't message me again" }))).toEqual({
      kind: "stop",
    });
    expect(guardReply(reply({ kind: "stop", message: null }), guard())).toEqual({ kind: "stop" });
  });

  it("updates to things the business doesn't have are dropped", () => {
    const g = guardReply(
      reply({
        message: "Noted.",
        stageId: "0192c000-0000-7000-8000-0000000000ff",
        fields: { budget: "₹20 lakh", shoe_size: "9" },
        lostReasonId: "0192c000-0000-7000-8000-0000000000fe",
      }),
      guard({ permissions: AUTOPILOT_PRESETS.hands_off, prices: [2000000] }),
    );
    expect(g).toMatchObject({
      kind: "send",
      updates: { stageId: null, fields: { budget: "₹20 lakh" }, lostReasonId: null },
    });
  });

  it("converted and handover keep the lead's own words", () => {
    expect(
      guardReply(
        reply({ kind: "converted", message: null, reason: "Site visit agreed", evidence: "Saturday works" }),
        guard(),
      ),
    ).toEqual({ kind: "converted", reason: "Site visit agreed", evidence: "Saturday works" });
  });

  it("a first message is only one of the approved templates offered", () => {
    expect(guardFirst({ templateId: TEMPLATE, why: "A first hello." }, [TEMPLATE])).toBe(TEMPLATE);
    expect(guardFirst({ templateId: OTHER_FILE, why: "?" }, [TEMPLATE])).toBeNull();
  });

  it("the default profile's presets are what the guards read", () => {
    expect(DEFAULT_AI_PROFILE.standing.permissions).toEqual(AUTOPILOT_PRESETS.balanced);
  });
});
