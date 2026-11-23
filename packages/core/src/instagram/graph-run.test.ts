import { describe, expect, it } from "vitest";
import { NEW_RUN, stepRun, type FlowCtx, type FlowStep, type RunState } from "./flows";
import type { FlowGraph, GNode } from "./graph";
import { graphRefs, nextAt, stepFlow, stepGraph } from "./graph-run";

/** Graph flows at work (plan 2026-11-23-flow-builder, Task A2): exits, waits, checks, splits, and no loop forever. */
const now = new Date("2026-11-23T06:00:00Z"); // 11:30 in Kolkata, a Monday
const open = { state: "open" as const, until: new Date(now.getTime() + 86_400_000) };
const ctx = (o: Partial<FlowCtx> = {}): FlowCtx => ({
  now,
  window: open,
  privateReplyOnly: false,
  lead: { tags: [], fields: {} },
  personWords: ["PERSON"],
  tz: "Asia/Kolkata",
  seed: "run-1",
  ...o,
});
const graph = (start: string, ...nodes: GNode[]): FlowGraph => ({ v: 2, start, nodes, pos: {}, notes: [] });
const msg = (id: string, o: Partial<Extract<GNode, { type: "message" }>> = {}): GNode => ({
  id,
  type: "message",
  text: `Say ${id}`,
  buttons: [],
  replies: [],
  next: null,
  ...o,
});
const run = (g: FlowGraph, state: RunState = NEW_RUN, c = ctx()) =>
  stepGraph(g, state, { kind: "start", via: "dm" }, c);
const sent = (r: { actions: { kind: string; stepKey?: string }[] }) =>
  r.actions.filter((a) => a.kind === "send").map((a) => a.stepKey);

describe("quick replies that branch", () => {
  const g = graph(
    "hi",
    msg("hi", {
      replies: [
        { id: "y", title: "Yes, send it", next: "yes" },
        { id: "n", title: "Not now", next: "bye" },
      ],
    }),
    msg("yes"),
    msg("bye"),
  );

  it("waits for a tap, then goes down that reply's line (a tap, or its words typed)", () => {
    const a = run(g);
    expect(sent(a)).toEqual(["hi"]);
    expect(a.state.waiting).toEqual({ for: "reply", nodeId: "hi" });
    const tap = stepGraph(g, a.state, { kind: "message", text: "Yes, send it", payload: "qr:hi:y" }, ctx());
    expect(sent(tap)).toEqual(["yes"]);
    const typed = stepGraph(g, a.state, { kind: "message", text: "  not NOW " }, ctx());
    expect(sent(typed)).toEqual(["bye"]);
  });

  it("other words: down 'anything else' when the message has one, else a person reads them (owner 2026-11-23)", () => {
    const a = run(g);
    const off = stepGraph(g, a.state, { kind: "message", text: "hmm" }, ctx());
    expect(off.done).toEqual({ reason: "handed" });
    expect(off.actions).toContainEqual({ kind: "handoff", to: "person", note: "Didn't pick a reply" });
    const g2 = graph(
      "hi",
      { ...(g.nodes[0] as Extract<GNode, { type: "message" }>), next: "bye" },
      msg("yes"),
      msg("bye"),
    );
    expect(sent(stepGraph(g2, run(g2).state, { kind: "message", text: "hmm" }, ctx()))).toEqual(["bye"]);
  });

  it("replies that lead nowhere are suggestions: the run carries on (as 1B's did)", () => {
    const g3 = graph(
      "hi",
      msg("hi", { replies: [{ id: "y", title: "Ok", next: null }], next: "after" }),
      msg("after"),
    );
    expect(sent(run(g3))).toEqual(["hi", "after"]);
  });
});

describe("questions", () => {
  const ask: GNode = {
    id: "q",
    type: "ask",
    text: "Your email?",
    save: { field: "email", kind: "email" },
    retry: "That doesn't look like an email.",
    next: "thanks",
    noAnswer: { afterMinutes: 60, next: "nudge" },
  };
  const g = graph("q", ask, msg("thanks"), msg("nudge"));

  it("an answer saves and goes on; no answer by the deadline takes No answer", () => {
    const a = run(g);
    expect(a.state.waiting).toEqual({ for: "answer", stepId: "q", until: "2026-11-23T07:00:00.000Z" });
    const ok = stepGraph(g, a.state, { kind: "message", text: "Priya@Example.test" }, ctx());
    expect(ok.actions[0]).toEqual({ kind: "saveField", field: "email", value: "priya@example.test" });
    expect(sent(ok)).toEqual(["thanks"]);
    const early = stepGraph(g, a.state, { kind: "timer", now: new Date("2026-11-23T06:59:00Z") }, ctx());
    expect(early.actions).toEqual([]);
    const late = stepGraph(g, a.state, { kind: "timer", now: new Date("2026-11-23T07:00:01Z") }, ctx());
    expect(sent(late)).toEqual(["nudge"]);
  });

  it("a choice goes down its own line", () => {
    const pickOne: GNode = {
      id: "c",
      type: "ask",
      text: "Which?",
      save: { field: "plan", kind: "choice" },
      choices: [
        { id: "a", title: "Basic", next: "basic" },
        { id: "b", title: "Pro", next: "pro" },
      ],
      retry: "Tap one.",
      next: null,
      noAnswer: { afterMinutes: 0, next: null },
    };
    const g2 = graph("c", pickOne, msg("basic"), msg("pro"));
    const a = run(g2);
    expect(a.state.waiting).toEqual({ for: "answer", stepId: "c" });
    expect(sent(stepGraph(g2, a.state, { kind: "message", text: "x", payload: "ask:c:1" }, ctx()))).toEqual([
      "pro",
    ]);
  });
});

describe("checks and split tests", () => {
  it("all or any, over tags, fields, stage, owner, source and the time of day in the business's zone", () => {
    const check = (rules: Extract<GNode, { type: "check" }>["rules"], match: "all" | "any" = "all") =>
      graph("c", { id: "c", type: "check", match, rules, yes: "y", no: "n" }, msg("y"), msg("n"));
    const c = ctx({
      lead: { tags: ["vip"], fields: { budget: "5000" }, stageId: "s-new", ownerId: "u1", sourceId: "src" },
    });
    expect(
      sent(
        run(
          check([
            { on: "tag", key: "vip", op: "is" },
            { on: "stage", key: "", op: "is", value: "s-new" },
          ]),
          NEW_RUN,
          c,
        ),
      ),
    ).toEqual(["y"]);
    expect(
      sent(
        run(
          check(
            [
              { on: "field", key: "budget", op: "gt", value: "10000" },
              { on: "owner", key: "", op: "is", value: "u1" },
            ],
            "any",
          ),
          NEW_RUN,
          c,
        ),
      ),
    ).toEqual(["y"]);
    expect(sent(run(check([{ on: "field", key: "budget", op: "gt", value: "10000" }]), NEW_RUN, c))).toEqual([
      "n",
    ]);
    // 11:30 in Kolkata: inside 09:00-18:00, outside 22:00-07:00 (an overnight span).
    expect(sent(run(check([{ on: "time", key: "09:00-18:00", op: "is" }]), NEW_RUN, c))).toEqual(["y"]);
    expect(sent(run(check([{ on: "time", key: "22:00-07:00", op: "is" }]), NEW_RUN, c))).toEqual(["n"]);
  });

  it("a split test: the same run always the same path; across runs, the paths by weight", () => {
    const g = graph(
      "s",
      {
        id: "s",
        type: "split",
        paths: [
          { id: "a", weight: 70, next: "a" },
          { id: "b", weight: 30, next: "b" },
        ],
      },
      msg("a"),
      msg("b"),
    );
    expect(sent(run(g, NEW_RUN, ctx({ seed: "r1" })))).toEqual(sent(run(g, NEW_RUN, ctx({ seed: "r1" }))));
    let a = 0;
    for (let i = 0; i < 2000; i++) if (sent(run(g, NEW_RUN, ctx({ seed: `run-${i}` })))[0] === "a") a++;
    expect(a / 2000).toBeGreaterThan(0.64);
    expect(a / 2000).toBeLessThan(0.76);
  });
});

describe("never forever", () => {
  it("a loop runs a step 3 times; the fourth waits for a person", () => {
    const g = graph(
      "follow",
      msg("follow", { replies: [{ id: "done", title: "I followed", next: "check" }] }),
      {
        id: "check",
        type: "check",
        match: "all",
        rules: [{ on: "tag", key: "follows", op: "is" }],
        yes: null,
        no: "follow",
      },
    );
    let r = run(g);
    for (let i = 0; i < 2; i++) r = stepGraph(g, r.state, { kind: "message", text: "I followed" }, ctx());
    expect(sent(r)).toEqual(["follow:3"]);
    const last = stepGraph(g, r.state, { kind: "message", text: "I followed" }, ctx());
    expect(last.done).toEqual({ reason: "handed" });
    expect(last.actions).toContainEqual({
      kind: "handoff",
      to: "person",
      note: "Went round 3 times; waiting for a person.",
    });
  });

  it("a chain longer than one turn may run (a graph that skipped the size check): 100 steps, then a person", () => {
    const nodes: GNode[] = Array.from({ length: 150 }, (_, i) => ({
      id: `u${i}`,
      type: "update" as const,
      actions: [],
      next: i < 149 ? `u${i + 1}` : null,
    }));
    const r = run(graph("u0", ...nodes));
    expect(r.done).toEqual({ reason: "handed" });
    expect(r.state.visits!.u99).toBe(1);
    expect(r.state.visits!.u100).toBeUndefined();
  });

  it("a run that started on 1B (no visits kept) carries on", () => {
    const g = graph("a", msg("a", { next: "b" }), msg("b"));
    expect(sent(stepGraph(g, { ...NEW_RUN }, { kind: "start", via: "dm" }, ctx()))).toEqual(["a", "b"]);
  });
});

describe("waits, the lead and the team", () => {
  it("wait until 09:00 on weekdays, in the business's zone; one past Meta's window ends the run", () => {
    // Monday 11:30 Kolkata: next weekday 09:00 is Tuesday 09:00 IST = 03:30 UTC.
    expect(nextAt(now, "09:00", [1, 2, 3, 4, 5], "Asia/Kolkata")!.toISOString()).toBe(
      "2026-11-24T03:30:00.000Z",
    );
    const g = graph(
      "w",
      { id: "w", type: "wait", for: { until: { time: "09:00", days: [1, 2, 3, 4, 5] } }, next: "m" },
      msg("m"),
    );
    expect(run(g).state.waiting).toEqual({ for: "until", until: "2026-11-24T03:30:00.000Z" });
    const short = ctx({ window: { state: "open", until: new Date(now.getTime() + 3_600_000) } });
    expect(run(g, NEW_RUN, short).done).toEqual({
      reason: "Instagram's time to reply would run out during this wait.",
    });
  });

  it("update the lead, tell the team, go to another flow", () => {
    const g = graph(
      "u",
      {
        id: "u",
        type: "update",
        actions: [
          { kind: "tag", tagId: "t1", add: true },
          { kind: "field", field: "plan", value: null },
          { kind: "task", title: "Call back", dueMinutes: 30 },
        ],
        next: "n",
      },
      { id: "n", type: "notify", to: "owner", text: "A hot one", next: "g" },
      { id: "g", type: "goto", flowId: "f2" },
    );
    const r = run(g);
    expect(r.actions).toEqual([
      { kind: "tag", tagId: "t1", add: true },
      { kind: "clearField", field: "plan" },
      { kind: "task", title: "Call back", dueMinutes: 30 },
      { kind: "notify", to: "owner", text: "A hot one" },
      { kind: "goto", flowId: "f2" },
    ]);
    expect(r.done).toEqual({ reason: "went to another flow" });
  });

  it("after a comment only the private reply goes, then it waits; a person word always hands over", () => {
    const g = graph("a", msg("a", { next: "b" }), msg("b"));
    const r = run(g, NEW_RUN, ctx({ privateReplyOnly: true }));
    expect(r.actions).toEqual([expect.objectContaining({ stepKey: "a", asPrivateReply: true })]);
    expect(r.state.waiting).toEqual({ for: "any" });
    const handed = stepGraph(g, r.state, { kind: "message", text: "person" }, ctx());
    expect(handed.done).toEqual({ reason: "handed" });
  });
});

describe("one entry for every flow, and what a turn ran", () => {
  it("each step a turn ran, a second visit keyed id:2, for the numbers and Replay", () => {
    const g = graph("a", msg("a", { replies: [{ id: "again", title: "Again", next: "a" }] }));
    const first = run(g);
    expect(first.entered).toEqual(["a"]);
    expect(stepGraph(g, first.state, { kind: "message", text: "Again" }, ctx()).entered).toEqual(["a:2"]);
  });

  it("a 1B list runs on 1B's interpreter, exactly as before; a graph on the graph's", () => {
    const list: FlowStep[] = [{ id: "s1", type: "send", text: "Hi" }];
    const ev = { kind: "start" as const, via: "dm" as const };
    expect(stepFlow(list, NEW_RUN, ev, ctx())).toEqual({ ...stepRun(list, NEW_RUN, ev, ctx()), entered: [] });
    expect(stepFlow(graph("a", msg("a")), NEW_RUN, ev, ctx()).entered).toEqual(["a"]);
  });

  it("every tag, stage, person and field a graph names, for the check before it goes live", () => {
    const g = graph(
      "c",
      {
        id: "c",
        type: "check",
        match: "any",
        rules: [
          { on: "tag", key: "t-check", op: "is" },
          { on: "stage", key: "", op: "is", value: "s-check" },
          { on: "owner", key: "", op: "is", value: "u-check" },
          { on: "field", key: "budget", op: "gt", value: "1" },
        ],
        yes: "u",
        no: null,
      },
      {
        id: "u",
        type: "update",
        actions: [
          { kind: "tag", tagId: "t-add", add: true },
          { kind: "stage", stageId: "s-move" },
          { kind: "assign", to: { mode: "round_robin", userIds: ["u-a", "u-b"] } },
        ],
        next: "n",
      },
      { id: "n", type: "notify", to: { userId: "u-told" }, text: "Hi", next: null },
    );
    const r = graphRefs(g);
    expect(r.tagIds.sort()).toEqual(["t-add", "t-check"]);
    expect(r.stageIds.sort()).toEqual(["s-check", "s-move"]);
    expect(r.userIds.sort()).toEqual(["u-a", "u-b", "u-check", "u-told"]);
    expect(r.fields).toEqual(["budget"]);
  });
});

describe("a timezone LUME's runtime doesn't know", () => {
  it("reads the time in UTC rather than stopping the run", () => {
    const g = graph(
      "c",
      {
        id: "c",
        type: "check",
        match: "all",
        rules: [{ on: "time", key: "05:00-07:00", op: "is" }],
        yes: "y",
        no: "n",
      },
      msg("y"),
      msg("n"),
    );
    // 06:00 UTC: inside 05:00-07:00 when read in UTC.
    expect(sent(run(g, NEW_RUN, ctx({ tz: "Mars/Olympus_Mons" })))).toEqual(["y"]);
  });
});
