import { describe, expect, it } from "vitest";
import { stepRun, validateFlow, type FlowCtx, type FlowStep, type RunState } from "./flows";

/** Flows (NEW_FEATURES_PLAN §4.5; plan 1B Task 1): the interpreter, pure. */
const now = new Date("2026-11-22T06:00:00Z");
const open = { state: "open" as const, until: new Date(now.getTime() + 20 * 3_600_000) };
const ctx = (o: Partial<FlowCtx> = {}): FlowCtx => ({
  now,
  window: open,
  privateReplyOnly: false,
  lead: { tags: [], fields: {} },
  personWords: ["PERSON", "human"],
  ...o,
});
const fresh: RunState = { at: null, waiting: null, answers: {}, sent: 0, fallbacks: [] };

const magnet: FlowStep[] = [
  {
    id: "hello",
    type: "send",
    text: "Here's the guide!",
    quickReplies: [{ title: "Send it", payload: "go" }],
  },
  {
    id: "email",
    type: "ask",
    text: "What's your email?",
    save: { field: "email", kind: "email" },
    fallback: "That doesn't look like an email. Try again?",
  },
  {
    id: "c1",
    type: "condition",
    when: { on: "answer", key: "email", op: "contains", value: "@" },
    then: [{ id: "tagit", type: "tag", tagId: "t-guide", add: true }],
    else: [],
  },
  { id: "book", type: "book", text: "Want a call?", url: "https://cal.example.test/book" },
];

describe("stepRun", () => {
  it("a DM start runs until it needs an answer, then waits", () => {
    const r = stepRun(magnet, fresh, { kind: "start", via: "dm" }, ctx());
    expect(r.actions.map((a) => a.kind)).toEqual(["send", "send"]);
    expect(r.actions[0]).toMatchObject({ stepKey: "hello", asPrivateReply: false });
    expect(r.actions[1]).toMatchObject({ stepKey: "email", message: { text: "What's your email?" } });
    expect(r.state.waiting).toEqual({ for: "answer", stepId: "email" });
    expect(r.done).toBeUndefined();
  });

  it("an answer is saved typed, branches run, and the booking link goes as a button", () => {
    const a = stepRun(magnet, fresh, { kind: "start", via: "dm" }, ctx());
    const b = stepRun(magnet, a.state, { kind: "message", text: "  Priya@Example.TEST " }, ctx());
    expect(b.actions).toEqual([
      { kind: "saveField", field: "email", value: "priya@example.test" },
      { kind: "tag", tagId: "t-guide", add: true },
      {
        kind: "send",
        stepKey: "book",
        asPrivateReply: false,
        message: {
          text: "Want a call?",
          buttons: [{ title: "Book a call", url: "https://cal.example.test/book" }],
        },
      },
    ]);
    expect(b.done).toEqual({ reason: "finished" });
  });

  it("a wrong answer gets the fallback once, then a person", () => {
    const a = stepRun(magnet, fresh, { kind: "start", via: "dm" }, ctx());
    const b = stepRun(magnet, a.state, { kind: "message", text: "hi" }, ctx());
    expect(b.actions).toEqual([
      expect.objectContaining({
        kind: "send",
        stepKey: "email:fallback",
        message: { text: "That doesn't look like an email. Try again?" },
      }),
    ]);
    expect(b.done).toBeUndefined();
    const c = stepRun(magnet, b.state, { kind: "message", text: "still no" }, ctx());
    expect(c.actions).toEqual([{ kind: "handoff", to: "person", note: "Didn't answer What's your email?" }]);
    expect(c.done).toEqual({ reason: "handed" });
  });

  it("a comment start sends one private reply, then waits for the person to write", () => {
    const a = stepRun(
      magnet,
      fresh,
      { kind: "start", via: "comment" },
      ctx({ privateReplyOnly: true, window: { state: "closed", since: null } }),
    );
    expect(a.actions).toEqual([
      expect.objectContaining({ kind: "send", stepKey: "hello", asPrivateReply: true }),
    ]);
    expect(a.state.waiting).toEqual({ for: "any" });
    // The tap opens the window and the flow carries on.
    const b = stepRun(magnet, a.state, { kind: "message", text: "Send it", payload: "go" }, ctx());
    expect(b.actions.map((x) => x.kind)).toEqual(["send"]);
    expect(b.actions[0]).toMatchObject({ stepKey: "email", asPrivateReply: false });
  });

  it("a comment start on a booking step: the button is the one private reply, then it waits", () => {
    const flow: FlowStep[] = [
      { id: "b", type: "book", text: "Pick a time", url: "https://cal.example.test/b" },
      { id: "s", type: "send", text: "Anything else?" },
    ];
    const a = stepRun(flow, fresh, { kind: "start", via: "comment" }, ctx({ privateReplyOnly: true }));
    expect(a.actions).toEqual([expect.objectContaining({ stepKey: "b", asPrivateReply: true })]);
    expect(a.state.waiting).toEqual({ for: "any" });
  });

  it("nothing more than the one private reply while the person hasn't written", () => {
    const a = stepRun(magnet, fresh, { kind: "start", via: "comment" }, ctx({ privateReplyOnly: true }));
    const b = stepRun(magnet, a.state, { kind: "timer", now }, ctx({ privateReplyOnly: true }));
    expect(b.actions).toEqual([]);
  });

  it("never sends outside Meta's open window: the run ends with words", () => {
    const r = stepRun(
      magnet,
      fresh,
      { kind: "start", via: "dm" },
      ctx({ window: { state: "human", until: now } }),
    );
    expect(r.actions).toEqual([]);
    expect(r.done).toEqual({ reason: "Instagram's time to reply ran out before this step." });
  });

  it("a wait inside the window waits; one past it ends the run", () => {
    const flow: FlowStep[] = [
      { id: "w", type: "wait", minutes: 60 },
      { id: "s", type: "send", text: "Still there?" },
    ];
    const a = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(a.state.waiting).toEqual({ for: "until", until: "2026-11-22T07:00:00.000Z" });
    expect(
      stepRun(flow, a.state, { kind: "timer", now: new Date("2026-11-22T06:30:00Z") }, ctx()).actions,
    ).toEqual([]);
    const later = new Date("2026-11-22T07:00:00Z");
    expect(stepRun(flow, a.state, { kind: "timer", now: later }, ctx({ now: later })).actions).toEqual([
      expect.objectContaining({ stepKey: "s" }),
    ]);
    const long: FlowStep[] = [{ id: "w", type: "wait", minutes: 21 * 60 }, ...flow.slice(1)];
    expect(stepRun(long, fresh, { kind: "start", via: "dm" }, ctx()).done).toEqual({
      reason: "Instagram's time to reply would run out during this wait.",
    });
  });

  it("conditions on a tag, a field and emptiness", () => {
    const flow = (when: Extract<FlowStep, { type: "condition" }>["when"]): FlowStep[] => [
      {
        id: "c",
        type: "condition",
        when,
        then: [{ id: "y", type: "send", text: "yes" }],
        else: [{ id: "n", type: "send", text: "no" }],
      },
    ];
    const said = (f: FlowStep[], lead: FlowCtx["lead"]) =>
      (stepRun(f, fresh, { kind: "start", via: "dm" }, ctx({ lead })).actions[0] as { stepKey: string })
        .stepKey;
    expect(said(flow({ on: "tag", key: "vip", op: "is" }), { tags: ["vip"], fields: {} })).toBe("y");
    expect(said(flow({ on: "tag", key: "vip", op: "is" }), { tags: [], fields: {} })).toBe("n");
    expect(
      said(flow({ on: "field", key: "city", op: "is", value: "PUNE" }), {
        tags: [],
        fields: { city: "Pune" },
      }),
    ).toBe("y");
    expect(said(flow({ on: "field", key: "city", op: "empty" }), { tags: [], fields: { city: "  " } })).toBe(
      "y",
    );
    expect(said(flow({ on: "field", key: "city", op: "not_empty" }), { tags: [], fields: {} })).toBe("n");
  });

  it("a choice question takes a tap or the words", () => {
    const flow: FlowStep[] = [
      {
        id: "q",
        type: "ask",
        text: "Which plan?",
        save: { field: "plan", kind: "choice" },
        choices: ["Basic", "Coaching"],
        fallback: "Pick one?",
      },
    ];
    const a = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(a.actions[0]).toMatchObject({
      message: {
        quickReplies: [
          { title: "Basic", payload: "ask:q:0" },
          { title: "Coaching", payload: "ask:q:1" },
        ],
      },
    });
    expect(
      stepRun(flow, a.state, { kind: "message", text: "x", payload: "ask:q:1" }, ctx()).actions[0],
    ).toEqual({
      kind: "saveField",
      field: "plan",
      value: "Coaching",
    });
    expect(stepRun(flow, a.state, { kind: "message", text: "basic" }, ctx()).actions[0]).toMatchObject({
      value: "Basic",
    });
  });

  it("a step that's gone (a version changed under the run) ends it with words", () => {
    const waited = {
      ...fresh,
      at: "nope",
      waiting: { for: "until" as const, until: "2026-11-22T05:00:00.000Z" },
    };
    const r = stepRun(magnet, waited, { kind: "timer", now }, ctx());
    expect(r.done).toEqual({ reason: "This flow changed while the conversation was in it." });
  });

  it("hand to a person and to LUME AI end the run", () => {
    const flow: FlowStep[] = [{ id: "h", type: "handoff", to: "person", note: "Wants a custom plan" }];
    expect(stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx())).toMatchObject({
      actions: [{ kind: "handoff", to: "person", note: "Wants a custom plan" }],
      done: { reason: "handed" },
    });
  });

  it("a booking step without its link can't be published", () => {
    expect(validateFlow([{ id: "b", type: "book", text: "Want a call?", url: " " }])).toEqual([
      "Add the link people book a call on (https://…).",
    ]);
    expect(
      validateFlow([{ id: "b", type: "book", text: "Want a call?", url: "http://cal.example.test" }]),
    ).toEqual(["A button's link must start with https://."]);
  });
});

describe("a person is one word away", () => {
  it("the account's word, alone and in any case, hands over mid-question; inside a sentence it doesn't", () => {
    const a = stepRun(magnet, fresh, { kind: "start", via: "dm" }, ctx());
    expect(stepRun(magnet, a.state, { kind: "message", text: " person! " }, ctx())).toMatchObject({
      actions: [{ kind: "handoff", to: "person", note: "Asked for a person" }],
      done: { reason: "handed" },
    });
    const b = stepRun(magnet, a.state, { kind: "message", text: "is a person reading this?" }, ctx());
    expect(b.actions[0]).toMatchObject({ stepKey: "email:fallback" });
    // The business chose other words: PERSON is just an answer then.
    const c = stepRun(magnet, a.state, { kind: "message", text: "PERSON" }, ctx({ personWords: ["team"] }));
    expect(c.actions[0]).toMatchObject({ stepKey: "email:fallback" });
  });

  it("also while a wait runs, and after the private reply", () => {
    const flow: FlowStep[] = [
      { id: "w", type: "wait", minutes: 60 },
      { id: "s", type: "send", text: "later" },
    ];
    const a = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(stepRun(flow, a.state, { kind: "message", text: "HUMAN" }, ctx()).done).toEqual({
      reason: "handed",
    });
  });
});

describe("Hand to LUME AI", () => {
  it("ends the flow and passes the goal on", () => {
    const flow: FlowStep[] = [
      { id: "s", type: "send", text: "Hi!" },
      {
        id: "h",
        type: "handoff",
        to: "ai",
        note: "From the guide flow",
        goal: { kind: "stage", stageId: "st-call" },
      },
      { id: "after", type: "send", text: "never" },
    ];
    const r = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(r.actions).toEqual([
      expect.objectContaining({ kind: "send", stepKey: "s" }),
      { kind: "handoff", to: "ai", note: "From the guide flow", goal: { kind: "stage", stageId: "st-call" } },
    ]);
    expect(r.done).toEqual({ reason: "handed" });
  });
});

describe("limits", () => {
  it("an answer longer than a flow keeps gets the fallback", () => {
    const flow: FlowStep[] = [
      {
        id: "q",
        type: "ask",
        text: "Your goal?",
        save: { field: "goal", kind: "text" },
        fallback: "In a line or two?",
      },
    ];
    const a = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(
      stepRun(flow, a.state, { kind: "message", text: "x".repeat(501) }, ctx()).actions[0],
    ).toMatchObject({
      stepKey: "q:fallback",
    });
    expect(
      stepRun(flow, a.state, { kind: "message", text: "😀".repeat(500) }, ctx()).actions[0],
    ).toMatchObject({
      kind: "saveField",
    });
  });

  it("a run that has sent its most ends with words, the fallback included", () => {
    const flow: FlowStep[] = [
      { id: "q", type: "ask", text: "Email?", save: { field: "email", kind: "email" }, fallback: "Again?" },
    ];
    const a = stepRun(flow, { ...fresh, sent: 19 }, { kind: "start", via: "dm" }, ctx());
    expect(a.state.sent).toBe(20);
    expect(stepRun(flow, a.state, { kind: "message", text: "nope" }, ctx())).toMatchObject({
      actions: [],
      done: { reason: "This flow sent as many messages as one run may." },
    });
  });

  it("a long flow is bounded: 50 sends in a row stop at 20", () => {
    const flow = Array.from({ length: 50 }, (_, i): FlowStep => ({
      id: `s${i}`,
      type: "send",
      text: `m${i}`,
    }));
    const r = stepRun(flow, fresh, { kind: "start", via: "dm" }, ctx());
    expect(r.actions).toHaveLength(20);
    expect(r.done).toEqual({ reason: "This flow sent as many messages as one run may." });
  });
});

describe("validateFlow", () => {
  it("accepts a good flow", () => {
    expect(validateFlow(magnet)).toEqual([]);
  });
  it("says what's wrong, in words", () => {
    expect(validateFlow([])).toEqual(["A flow needs at least one step."]);
    expect(validateFlow([{ id: "a", type: "send", text: "x".repeat(1001) }])[0]).toMatch(
      /too long for Instagram/,
    );
    expect(
      validateFlow([
        { id: "a", type: "send", text: "hi" },
        { id: "a", type: "send", text: "again" },
      ]),
    ).toEqual(["Two steps have the same id."]);
    const toAi: FlowStep[] = [{ id: "a", type: "handoff", to: "ai", goal: { kind: "reply" } }];
    expect(validateFlow(toAi)).toEqual([
      "LUME AI isn't answering Instagram in this LUME yet. Hand to a person for now.",
    ]);
    expect(validateFlow(toAi, { ai: true })).toEqual([]);
    expect(
      validateFlow([{ id: "a", type: "handoff", to: "ai", goal: { kind: "brief", text: "  " } }], {
        ai: true,
      }),
    ).toEqual(["Write what LUME AI should aim for."]);
    expect(validateFlow([{ id: "a", type: "wait", minutes: 7 * 24 * 60 + 1 }])).toEqual([
      "A wait is from 1 minute to 7 days.",
    ]);
    expect(validateFlow([{ id: "a", type: "assign", to: { mode: "round_robin", userIds: [] } }])).toEqual([
      "Choose who shares these leads.",
    ]);
    const deep = (n: number): FlowStep[] =>
      n === 0
        ? [{ id: `s${n}`, type: "send", text: "x" }]
        : [
            {
              id: `c${n}`,
              type: "condition",
              when: { on: "tag", key: "t", op: "is" },
              then: deep(n - 1),
              else: [],
            },
          ];
    expect(validateFlow(deep(5))).toEqual([]);
    expect(validateFlow(deep(6))).toEqual(["Branches can go 5 deep at most."]);
    expect(
      validateFlow(Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, type: "send" as const, text: "x" }))),
    ).toEqual(["A flow can have at most 50 steps."]);
    expect(
      validateFlow([
        {
          id: "q",
          type: "ask",
          text: "Plan?",
          save: { field: "plan", kind: "choice" },
          choices: [],
          fallback: "?",
        },
      ]),
    ).toEqual(["A choice question needs 2 to 13 choices."]);
  });
});
