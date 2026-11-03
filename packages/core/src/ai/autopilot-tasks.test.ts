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
  businessWordsOf,
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
  businessWords: "",
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
    fields: [],
    followUp: null,
    lostReasonId: null,
    ...o,
  });

describe("what LUME AI is asked", () => {
  it("the instructions name each answer's length limit, the message's included (eval 2026-10-31)", () => {
    expect(autopilotInstructions("autopilot_first", ctx())).toMatch(/why.*at most 200 characters/);
    const say = autopilotInstructions("autopilot_reply", ctx());
    expect(say).toMatch(/message.*at most 1,000 characters/);
    expect(say).toMatch(/reason.*at most 200 characters/);
    expect(say).toMatch(/evidence.*at most 300 characters/);
  });

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
    // Eval 2026-11-02: a decline with a reason closes and marks lost (never do not contact); health and money questions
    // go to a person; a proposed slot is the goal reached; no promised file without attaching it.
    expect(say).toMatch(/chose another business or already bought elsewhere[\s\S]*set the lost stage/);
    expect(say).toMatch(/health, symptoms, medicine or treatment, or about investment returns/);
    expect(say).toMatch(/never hand over for want of a calendar/);
    expect(say).toMatch(/Never say you're sending a file unless it's attached/);
    expect(say.toLowerCase()).not.toMatch(/pretend|deny being|you are a human/);
    const handOver = autopilotInstructions(
      "autopilot_reply",
      ctx({ profile: mergeAiProfile(profile, { standing: { botQuestion: "hand_over" } }) }),
    );
    expect(handOver).toContain("whether they are talking to a bot or AI, answer with kind handover");
  });

  it("in a chat under way, no greeting by name and no sign-off on every message; the first one has both (live test 2026-11-01)", () => {
    // Only the lead has written so far: the business's first message, signed off.
    expect(autopilotInstructions("autopilot_reply", ctx())).toContain('Sign off as "Team Brightpath"');
    const going = autopilotInstructions(
      "autopilot_reply",
      ctx({
        thread: [
          { from: "business", at: "2026-10-22T09:00:00Z", text: "Hi Sneha, thanks for your enquiry." },
          { from: "lead", at: "2026-10-22T10:00:00Z", text: "What does a kitchen cost?" },
        ],
      }),
    );
    expect(going).not.toContain('Sign off as "Team Brightpath"');
    expect(going).toMatch(/don't open with a greeting or their name, and don't sign off/i);
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
    expect(say).toContain("fill only the empty fields given, as key and value pairs");
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

  it("a file it says it's sending goes with it, or the reply goes to a person (eval 2026-11-02)", () => {
    // Eval: "Sure, sharing our brochure here." with nothing attached: the lead would wait for a file that never came.
    const promised = (message: string, fileIds: string[] = []) =>
      guardReply(reply({ message, fileIds }), guard()).kind;
    expect(promised("Sure, sharing our brochure here.")).toBe("handover");
    expect(promised("I've attached the floor plans for you.")).toBe("handover");
    expect(promised("Zaroor, floor plans bhej raha hu.")).toBe("handover");
    expect(promised("I'll send the price list shortly.")).toBe("handover");
    expect(promised("Sure, sharing our brochure here.", [FILE])).toBe("send");
    // An offer, or a request to the lead, promises nothing.
    expect(promised("Would you like me to send our brochure?")).toBe("send");
    expect(promised("Please share a few photos of the space so we can plan.")).toBe("send");
    expect(guardReply(reply({ message: "Sharing our brochure here." }), guard())).toMatchObject({
      kind: "handover",
      reason: "LUME AI said it was sending a file, but none was attached.",
    });
  });

  it("the business's own hours may be said; a slot neither the business nor the lead gave is still held (eval 2026-10-31)", () => {
    // Every held reply in the Sonnet 5.5 eval repeated hours the business wrote in Settings → LUME AI.
    const hours = guard({
      businessWords: "We are open Monday to Saturday, 10 am to 7 pm, near Baner metro.",
    });
    expect(
      guardReply(
        reply({ message: "We're open Monday to Saturday, 10 am to 7 pm. Which day suits you?" }),
        hours,
      ),
    ).toMatchObject({ kind: "send" });
    expect(guardReply(reply({ message: "Shall we say Saturday 4 pm?" }), hours)).toMatchObject({
      kind: "handover",
      reason: "LUME AI wanted to offer a time you haven't given it.",
    });
  });

  it("a time matches whole: a lead's 11 pm never lets 1 pm through", () => {
    const g = guard({ leadWords: "I'm free after 11 pm", lastLeadMessage: "I'm free after 11 pm" });
    // Only the time differs ("tomorrow" would be held on its own and hide what's tested).
    expect(guardReply(reply({ message: "How about 1 pm instead?" }), g)).toMatchObject({
      kind: "handover",
    });
    // Not "see you then": with nothing booked, that's a call promised (spec 2026-11-02), held on its own.
    expect(guardReply(reply({ message: "11 pm works for us too." }), g)).toMatchObject({ kind: "send" });
  });

  it("the business's words are its about, its questions and answers and its price notes", () => {
    const words = businessWordsOf({
      ...DEFAULT_AI_PROFILE,
      knows: {
        ...DEFAULT_AI_PROFILE.knows,
        about: "A clinic on Baner Road.",
        faqs: [{ q: "When are you open?", a: "Monday to Saturday, 10 am to 7 pm." }],
        prices: [
          { id: "p1", item: "Consultation", price: 800, unit: "per visit", notes: "Sundays by appointment" },
        ],
      },
    });
    for (const w of [
      "Baner Road",
      "When are you open?",
      "10 am to 7 pm",
      "Consultation",
      "Sundays by appointment",
    ])
      expect(words).toContain(w);
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

  it("a month is a whole word: decide, market, marble, junior aren't dates; May only beside a day (review 2026-10-26 A6)", () => {
    expect(timesIn("We can decide on the market price, the marble and the junior suite")).toEqual([]);
    expect(timesIn("You may come any day")).toEqual([]);
    expect(timesIn("How about May 5, or the 12th of September?")).toEqual(["may", "12th", "sep"]);
    expect(timesIn("on 5th may")).toEqual(["5th", "may"]);
    expect(guardReply(reply({ message: "Let's decide the marble finish together." }), guard())).toMatchObject(
      {
        kind: "send",
      },
    );
  });

  it("a discount LUME AI makes up hands over, like a price (review 2026-10-26 A7)", () => {
    expect(guardReply(reply({ message: "Book this week and get 20% off!" }), guard())).toEqual({
      kind: "handover",
      reason: "LUME AI wanted to offer a discount you haven't given it.",
      evidence: null,
    });
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
        fields: [
          { key: "budget", value: "₹20 lakh" },
          { key: "shoe_size", value: "9" },
        ],
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

/** Calls LUME AI may say yes to (spec 2026-11-02 LUME AI books calls). */
describe("a call LUME AI says yes to", () => {
  const TZ = "Asia/Dubai";
  const rules = {
    windows: [{ days: [1, 2, 3, 4, 5], from: "16:00", to: "19:00" }],
    minutes: 30,
    noticeHours: 2,
    daysAhead: 14,
    how: "We'll call you on this number.",
  };
  // Monday 2 November 2026, 10:00 in Dubai.
  const now = new Date("2026-11-02T06:00:00Z");
  const calls = { rules, tz: TZ, now, busy: [] };
  const asked = "Can we talk tomorrow at 5 pm?";
  const g = (o: Partial<GuardCtx> = {}) => guard({ lastLeadMessage: asked, leadWords: asked, calls, ...o });
  const yes = (at: string | null, message = "Done, tomorrow at 5 pm. We'll call you on this number.") =>
    reply({ message, meeting: at === null ? null : { at } });

  it("a free time inside the ones given is booked with the reply", () => {
    expect(guardReply(yes("2026-11-03T17:00"), g())).toMatchObject({
      kind: "send",
      updates: { meeting: { at: "2026-11-03T13:00:00.000Z" } },
    });
  });

  it("set to Ask me, the reply and the booking wait for a tap, before anything but losing a lead or a price", () => {
    const perms = {
      ...AUTOPILOT_PRESETS.hands_off,
      book_meetings: "ask" as const,
      move_stages: "ask" as const,
    };
    expect(guardReply(yes("2026-11-03T17:00"), g({ permissions: perms }))).toMatchObject({
      kind: "ask",
      action: "book_meetings",
      updates: { meeting: { at: "2026-11-03T13:00:00.000Z" } },
    });
  });

  it("set to Never, or with no times given, a booking goes to a person", () => {
    const never = { ...AUTOPILOT_PRESETS.hands_off, book_meetings: "never" as const };
    expect(guardReply(yes("2026-11-03T17:00"), g({ permissions: never }))).toMatchObject({
      kind: "handover",
      reason: '"Book meetings" is set to Never.',
    });
    expect(guardReply(yes("2026-11-03T17:00"), g({ calls: null }))).toMatchObject({ kind: "handover" });
  });

  it("each time LUME can't say yes to goes to a person, with why", () => {
    const why = (at: string, o: Partial<GuardCtx> = {}) => {
      const r = guardReply(yes(at), g(o));
      return r.kind === "handover" ? r.reason : r.kind;
    };
    expect(why("2026-11-03T20:00")).toMatch(/outside the times you gave it/);
    expect(why("2026-11-02T11:00")).toMatch(/outside the times you gave it/);
    expect(why("2026-11-02T16:00", { calls: { ...calls, now: new Date("2026-11-02T11:00:00Z") } })).toMatch(
      /sooner than/,
    );
    expect(why("2026-11-30T17:00")).toMatch(/further ahead/);
    const busy = [{ start: new Date("2026-11-03T13:00:00Z"), end: new Date("2026-11-03T14:00:00Z") }];
    expect(why("2026-11-03T17:00", { calls: { ...calls, busy } })).toMatch(/already have a meeting/);
    expect(why("tomorrow 5pm")).toMatch(/couldn't read/);
  });

  it("the message says the time it booked, never another", () => {
    const r = guardReply(yes("2026-11-03T17:00", "Done, Wednesday at 6 pm."), g());
    expect(r).toMatchObject({
      kind: "handover",
      reason: "LUME AI wanted to offer a time you haven't given it.",
    });
  });

  it("may offer the free times it was given, without booking", () => {
    const r = guardReply(
      yes(null, "Tomorrow's taken at 5, but 4 pm tomorrow or Wednesday at 4 pm are free."),
      g(),
    );
    expect(r).toMatchObject({ kind: "send", updates: { meeting: null } });
  });

  it("saying a call is booked without booking it goes to a person", () => {
    for (const message of ["Done, see you tomorrow at 5 pm!", "You're booked for tomorrow at 5 pm."])
      expect(guardReply(yes(null, message), g()), message).toMatchObject({
        kind: "handover",
        reason: "LUME AI said a call was booked, but didn't book it.",
      });
    // A question isn't a booking.
    expect(guardReply(yes(null, "Shall I book you for tomorrow at 5 pm?"), g())).toMatchObject({
      kind: "send",
    });
  });

  it("the instructions give the times, the length, the notice and how it happens; the free times are in the input", () => {
    const c = ctx({
      calls: {
        windows: "Monday to Friday 16:00 to 19:00",
        minutes: 30,
        noticeHours: 2,
        daysAhead: 14,
        how: "We'll call you on this number.",
        free: [{ at: "2026-11-02T16:00", label: "November 2, Monday at 4 pm" }],
      },
    });
    const say = autopilotInstructions("autopilot_reply", c);
    for (const words of [
      "Monday to Friday 16:00 to 19:00",
      "30 minutes",
      "2 hours",
      "14 days",
      "We'll call you on this number.",
    ])
      expect(say, words).toContain(words);
    expect(say).toMatch(/set meeting\.at/);
    expect(say).not.toMatch(/never hand over for want of a calendar/);
    expect(JSON.parse(autopilotInput("autopilot_reply", c)).callTimes).toEqual([
      { at: "2026-11-02T16:00", label: "November 2, Monday at 4 pm" },
    ]);
    // No times given: as before, a proposed time is the goal reached for a person to confirm.
    expect(autopilotInstructions("autopilot_reply", ctx())).toMatch(/never hand over for want of a calendar/);
    expect(JSON.parse(autopilotInput("autopilot_reply", ctx())).callTimes).toBeUndefined();
  });

  it("LUME makes the Meet link (spec 2026-11-03): the model never writes a link, and the how words give way to it", () => {
    const calls = {
      windows: "Monday to Friday 16:00 to 19:00",
      minutes: 30,
      noticeHours: 2,
      daysAhead: 14,
      how: "We'll call you on this number.",
      free: [],
    };
    const say = autopilotInstructions("autopilot_reply", ctx({ calls: { ...calls, meet: true } }));
    expect(say).toContain("LUME adds the Google Meet link under your message");
    expect(say).not.toContain("We'll call you on this number.");
    const off = autopilotInstructions("autopilot_reply", ctx({ calls: { ...calls, meet: false } }));
    expect(off).not.toContain("Google Meet");
    expect(off).toContain("We'll call you on this number.");
  });
});
