import { describe, expect, it } from "vitest";
import { blocking, flowGraphSchema, validateGraph, type FlowGraph, type GNode } from "../instagram/graph";
import {
  applyOps,
  buildFromAnswer,
  flowBuildInput,
  flowBuildInstructions,
  flowBuildOutput,
  opsBetween,
  type FlowBuildAnswer,
  type FlowBuildCtx,
} from "./flow-build";

/** LUME AI builds a flow (plan 2026-11-23-flow-builder, Task C1): its answer, repaired, as ops the builder plays. */

const TAG = "0190e0c0-0000-7000-8000-0000000000a1";
const STAGE = "0190e0c0-0000-7000-8000-0000000000b1";

function ctx(o: Partial<FlowBuildCtx> = {}): FlowBuildCtx {
  let n = 0;
  return {
    business: "Palm Studio",
    about: "",
    prompt: "Send the price list to people who comment PRICE",
    selection: [],
    trigger: "A comment with PRICE",
    stages: [{ id: STAGE, name: "Booked" }],
    tags: [{ id: TAG, label: "Hot" }],
    fields: [{ key: "goal", label: "Goal" }],
    ai: true,
    newId: () => `n${++n}`,
    ...o,
  };
}

type Step = FlowBuildAnswer["steps"][number];
const step = (o: Partial<Step> & Pick<Step, "id" | "type">): Step => ({
  text: "",
  links: [],
  options: [],
  weights: [],
  next: null,
  otherwise: null,
  save: null,
  retry: "",
  minutes: 0,
  match: "all",
  rules: [],
  changes: [],
  to: "owner",
  url: "",
  ...o,
});
const answer = (steps: Step[], start: string | null = steps[0]?.id ?? null): FlowBuildAnswer => ({
  plan: ["Say hello", "Send the prices"],
  said: "Here is a flow that sends the prices.",
  start,
  steps,
});

const empty: FlowGraph = { v: 2, start: null, nodes: [], pos: {}, notes: [] };
const msg = (id: string, text: string, next: string | null = null): GNode => ({
  id,
  type: "message",
  text,
  buttons: [],
  replies: [],
  next,
});
const draft: FlowGraph = {
  v: 2,
  start: "hello",
  nodes: [msg("hello", "Hi there", "bye"), { id: "bye", type: "end" }],
  pos: { hello: { x: 0, y: 0 }, bye: { x: 0, y: 180 } },
  notes: [{ id: "note1", x: 400, y: 0, text: "A note" }],
};

/** The same graph whatever order its steps are listed in. */
const same = (a: FlowGraph, b: FlowGraph) => {
  const byId = (g: FlowGraph) => Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  expect(byId(a)).toEqual(byId(b));
  expect(a.start).toBe(b.start);
  expect(a.pos).toEqual(b.pos);
  expect(a.notes).toEqual(b.notes);
};

describe("ops: what the builder plays, in order", () => {
  it("played into the draft they give exactly the next graph: adds, edits, removes, a new start and a loop back", () => {
    const next: FlowGraph = {
      v: 2,
      start: "a",
      nodes: [
        msg("hello", "Hi there, welcome", "a"),
        { id: "a", type: "wait", for: { minutes: 60 }, next: "b" },
        {
          id: "b",
          type: "message",
          text: "Still there?",
          buttons: [],
          replies: [
            { id: "b-r0", title: "Yes", next: "hello" },
            { id: "b-r1", title: "No", next: "a" },
          ],
          next: null,
        },
      ],
      pos: { hello: { x: 0, y: 0 }, a: { x: 0, y: 180 }, b: { x: 0, y: 360 } },
      notes: draft.notes,
    };
    const ops = opsBetween(draft, next);
    same(applyOps(draft, ops), next);
    expect(ops.filter((o) => o.op === "remove")).toEqual([{ op: "remove", nodeId: "bye" }]);
    expect(ops.filter((o) => o.op === "add").map((o) => (o.op === "add" ? o.node.id : ""))).toEqual([
      "a",
      "b",
    ]);
    // Each step lands with its lines open; a line is drawn once the step it leads to is there.
    const addB = ops.find((o) => o.op === "add" && o.node.id === "b");
    expect(addB && addB.op === "add" && addB.node.type === "message" && addB.node.replies[1]!.next).toBe("a");
  });

  it("the same graph is no ops, and an empty draft builds from nothing", () => {
    expect(opsBetween(draft, draft)).toEqual([]);
    const next: FlowGraph = { ...draft, notes: [] };
    same(applyOps(empty, opsBetween(empty, next)), { ...next, notes: [] });
  });

  it("removing a step leaves every line to it open, Starts when too", () => {
    const g = applyOps(draft, [{ op: "remove", nodeId: "hello" }]);
    expect(g.start).toBeNull();
    expect(applyOps(draft, [{ op: "remove", nodeId: "bye" }]).nodes[0]).toMatchObject({ next: null });
  });
});

describe("LUME AI's answer as the next graph", () => {
  it("builds a flow from nothing that passes the checks, with fresh ids and each child's own", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "ask1",
          type: "message",
          text: "Want the price list?",
          options: [
            { title: "Yes please", next: "prices" },
            { title: "Not now", next: "done" },
          ],
        }),
        step({
          id: "prices",
          type: "message",
          text: "Here it is",
          links: [{ title: "Prices", url: "https://palm.example/prices" }],
          next: "done",
        }),
        step({ id: "done", type: "end" }),
      ]),
      ctx(),
    );
    expect(r.refused).toBe(false);
    expect(blocking(validateGraph(r.graph, { ai: true }))).toEqual([]);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(r.graph.start).toBe("n1");
    const first = r.graph.nodes[0]!;
    expect(first.type === "message" && first.replies.map((x) => [x.id, x.next])).toEqual([
      ["n1-r0", "n2"],
      ["n1-r1", "n3"],
    ]);
    same(applyOps(empty, r.ops), r.graph);
    expect(r.plan).toEqual(["Say hello", "Send the prices"]);
  });

  it("a fourth button is left off, and LUME says so", () => {
    const links = [1, 2, 3, 4].map((i) => ({ title: `Link ${i}`, url: `https://palm.example/${i}` }));
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "m", type: "message", text: "Pick one", links })]),
      ctx(),
    );
    const m = r.graph.nodes[0]!;
    expect(m.type === "message" && m.buttons.map((b) => b.title)).toEqual(["Link 1", "Link 2", "Link 3"]);
    expect(r.said).toContain("Instagram allows 3 buttons on a message, so LUME kept the first 3.");
    expect(r.refused).toBe(false);
  });

  it("a line to a step that isn't there is left open, and said", () => {
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "m", type: "message", text: "Hi", next: "ghost" })]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({ next: null });
    expect(r.said).toContain("A line led to a step that isn't there, so LUME left it open.");
  });

  it("quick replies past 13 are left off, and a reply's words past 20 characters are cut at a word", () => {
    const options = Array.from({ length: 15 }, (_, i) => ({ title: `Option ${i}`, next: null }));
    options[0] = { title: "Tell me about the evening batches", next: null };
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "m", type: "message", text: "Which?", options })]),
      ctx(),
    );
    const m = r.graph.nodes[0]!;
    expect(m.type === "message" && m.replies.length).toBe(13);
    expect(m.type === "message" && m.replies[0]!.title).toBe("Tell me about the");
    expect(r.said).toContain("Instagram allows 13 quick replies on a message, so LUME kept the first 13.");
    expect(r.said).toContain("Instagram allows 20 characters on a quick reply, so LUME shortened some.");
  });

  it("replies that lead nowhere beside ones that do go where the message goes next", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "m",
          type: "message",
          text: "Which?",
          next: "e",
          options: [
            { title: "A", next: "e" },
            { title: "B", next: null },
          ],
        }),
        step({ id: "e", type: "end" }),
      ]),
      ctx(),
    );
    const m = r.graph.nodes[0]!;
    expect(m.type === "message" && m.replies.map((x) => x.next)).toEqual(["n2", "n2"]);
    expect(r.refused).toBe(false);
  });

  it("a tag, stage or field LUME doesn't have is left out of the change", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "u",
          type: "update",
          changes: [
            { kind: "tag_add", target: TAG, value: "" },
            { kind: "tag_add", target: "VIP", value: "" },
            { kind: "stage", target: "Won", value: "" },
            { kind: "field", target: "budget", value: "high" },
            { kind: "field", target: "goal", value: "Lose weight" },
          ],
        }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({
      actions: [
        { kind: "tag", tagId: TAG, add: true },
        { kind: "field", field: "goal", value: "Lose weight" },
      ],
    });
    expect(r.said).toContain(
      "Some changes named a tag, stage or field this LUME doesn't have, so LUME left them out.",
    );
  });

  it("hand to LUME AI becomes hand to a person when LUME AI isn't answering Instagram", () => {
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "h", type: "handoff", to: "ai" })]),
      ctx({ ai: false }),
    );
    expect(r.graph.nodes[0]).toMatchObject({ type: "handoff", to: "person" });
    expect(r.said).toContain(
      "LUME AI isn't answering Instagram here yet, so LUME hands to a person instead.",
    );
    expect(
      buildFromAnswer(empty, answer([step({ id: "h", type: "handoff", to: "ai" })]), ctx()).graph.nodes[0],
    ).toMatchObject({ to: "ai", goal: { kind: "reply" } });
  });

  it("split weights that don't add up to 100 are shared out evenly; a wait is kept between 1 minute and 7 days", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "s",
          type: "split",
          options: [
            { title: "A", next: "w" },
            { title: "B", next: "w" },
            { title: "C", next: "w" },
          ],
          weights: [50, 50, 50],
        }),
        step({ id: "w", type: "wait", minutes: 20_000 }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({ paths: [{ weight: 34 }, { weight: 33 }, { weight: 33 }] });
    expect(r.graph.nodes[1]).toMatchObject({ for: { minutes: 7 * 24 * 60 } });
    expect(r.said).toContain("The split test's paths didn't add up to 100%, so LUME shared them out evenly.");
    expect(r.said).toContain("A wait can be from 1 minute to 7 days, so LUME kept it inside that.");
  });

  it("a booking step without an https link becomes a message", () => {
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "b", type: "book", text: "Book your call", url: "http://palm.example" })]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({ type: "message", text: "Book your call" });
    expect(r.said).toContain(
      "A booking step needs a link that starts with https://, so LUME made it a message.",
    );
  });

  it("a message too long for Instagram is refused whole: nothing changes, and LUME says why", () => {
    const r = buildFromAnswer(
      draft,
      answer([step({ id: "m", type: "message", text: "x".repeat(1200) })]),
      ctx(),
    );
    expect(r.refused).toBe(true);
    expect(r.ops).toEqual([]);
    expect(r.graph).toBe(draft);
    expect(r.said).toMatch(/^LUME AI couldn't make this flow work on Instagram: This message is too long/);
    expect(r.said).toContain("Nothing changed.");
  });

  it("more than 100 steps is refused whole", () => {
    const steps = Array.from({ length: 101 }, (_, i) => step({ id: `s${i}`, type: "end" }));
    const r = buildFromAnswer(empty, answer(steps), ctx());
    expect(r.refused).toBe(true);
    expect(r.said).toContain("at most 100 steps");
  });

  it("a problem the draft already had doesn't refuse the answer", () => {
    const broken: FlowGraph = { ...draft, nodes: [msg("hello", "", "bye"), { id: "bye", type: "end" }] };
    const r = buildFromAnswer(
      broken,
      answer([
        step({ id: "hello", type: "message", text: "", next: "bye" }),
        step({ id: "bye", type: "end" }),
        step({ id: "x", type: "end" }),
      ]),
      ctx(),
    );
    expect(r.refused).toBe(false);
  });

  it("without a selection, a step the answer leaves out is taken out, and counted", () => {
    const r = buildFromAnswer(
      draft,
      answer([step({ id: "hello", type: "message", text: "Hi there" })]),
      ctx(),
    );
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["hello"]);
    expect(r.ops).toContainEqual({ op: "remove", nodeId: "bye" });
    expect(r.said).toContain("Took out 1 step.");
  });

  it("with a selection, every step outside it stays exactly as it was", () => {
    const r = buildFromAnswer(
      draft,
      answer([
        step({ id: "hello", type: "message", text: "Hello again", next: "bye" }),
        step({ id: "bye", type: "message", text: "Changed" }),
      ]),
      ctx({ selection: ["hello"] }),
    );
    expect(r.graph.nodes.find((n) => n.id === "bye")).toEqual({ id: "bye", type: "end" });
    expect(r.graph.nodes.find((n) => n.id === "hello")).toMatchObject({ text: "Hello again", next: "bye" });
    const r2 = buildFromAnswer(
      draft,
      answer([step({ id: "hello", type: "message", text: "Hi" })]),
      ctx({ selection: ["hello"] }),
    );
    expect(r2.graph.nodes.map((n) => n.id)).toEqual(["hello", "bye"]);
  });

  it("a kept step keeps its place and its file; a new step goes below the one before it, never on top of another", () => {
    const withMedia: FlowGraph = {
      ...draft,
      nodes: [
        {
          ...msg("hello", "Hi there", "bye"),
          media: { kind: "image", fileId: "0190e0c0-0000-7000-8000-0000000000f1" },
        } as GNode,
        { id: "bye", type: "end" },
      ],
    };
    const r = buildFromAnswer(
      withMedia,
      answer([
        step({ id: "hello", type: "message", text: "Hi there!", next: "new" }),
        step({ id: "new", type: "message", text: "One more thing", next: "bye" }),
        step({ id: "bye", type: "end" }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({ media: { kind: "image" } });
    expect(r.graph.pos.hello).toEqual({ x: 0, y: 0 });
    expect(r.graph.pos.bye).toEqual({ x: 0, y: 180 });
    // Depth 1 below Starts when is where bye sits: the new step moves right past it.
    expect(r.graph.pos.n1).toEqual({ x: 320, y: 180 });
    same(applyOps(withMedia, r.ops), r.graph);
  });

  it("a step LUME AI can't write (Go to another flow) is kept as it was", () => {
    const g: FlowGraph = {
      ...draft,
      nodes: [
        msg("hello", "Hi", "go"),
        { id: "go", type: "goto", flowId: "0190e0c0-0000-7000-8000-0000000000c1" },
      ],
      pos: { hello: { x: 0, y: 0 }, go: { x: 0, y: 180 } },
    };
    const r = buildFromAnswer(
      g,
      answer([
        step({ id: "hello", type: "message", text: "Hi", next: "go" }),
        step({ id: "go", type: "end" }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[1]).toEqual(g.nodes[1]);
  });
});

describe("LUME AI's answer, repaired step by step", () => {
  it("a message with buttons and quick replies keeps the quick replies, and LUME says so", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "m",
          type: "message",
          text: "Which?",
          links: [{ title: "Site", url: "https://palm.example" }],
          options: [{ title: "Yes", next: null }],
        }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({ buttons: [], replies: [{ title: "Yes" }] });
    expect(r.said).toContain(
      "A message can have quick replies or buttons, not both, so LUME kept the quick replies.",
    );
  });

  it("a question keeps 13 choices of at most 20 characters, and a deadline of at most 7 days", () => {
    const options = Array.from({ length: 15 }, (_, i) => ({ title: `Choice ${i}`, next: null }));
    options[0] = { title: "Mornings before the office opens", next: null };
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "q",
          type: "ask",
          text: "When suits you?",
          save: { field: "goal", kind: "choice" },
          options,
          minutes: 20_000,
          otherwise: "e",
        }),
        step({ id: "e", type: "end" }),
      ]),
      ctx(),
    );
    const q = r.graph.nodes[0]!;
    expect(q.type === "ask" && q.choices!.length).toBe(13);
    expect(q.type === "ask" && q.choices![0]!.title).toBe("Mornings before the");
    expect(q.type === "ask" && q.noAnswer.afterMinutes).toBe(7 * 24 * 60);
    expect(r.said).toContain("A question allows 13 choices, so LUME kept the first 13.");
    expect(r.said).toContain("Instagram allows 20 characters on a quick reply, so LUME shortened some.");
    expect(r.said).toContain("A wait can be from 1 minute to 7 days, so LUME kept it inside that.");
  });

  it("a check's rule on a tag or stage LUME doesn't have is left out; known ones stay", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "c",
          type: "check",
          match: "any",
          rules: [
            { on: "tag", key: TAG, op: "is", value: "" },
            { on: "tag", key: "VIP", op: "is", value: "" },
            { on: "stage", key: "", op: "is", value: STAGE },
            { on: "stage", key: "", op: "is", value: "Won" },
          ],
        }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({
      rules: [
        { on: "tag", key: TAG },
        { on: "stage", value: STAGE },
      ],
    });
    expect(r.said).toContain(
      "Some changes named a tag, stage or field this LUME doesn't have, so LUME left them out.",
    );
  });

  it("a split test keeps its first 12 paths", () => {
    const options = Array.from({ length: 14 }, (_, i) => ({ title: `P${i}`, next: null }));
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "s", type: "split", options, weights: options.map(() => 7) })]),
      ctx(),
    );
    const s = r.graph.nodes[0]!;
    expect(s.type === "split" && s.paths.length).toBe(12);
    expect(r.said).toContain("A split test has at most 12 paths, so LUME kept the first 12.");
  });

  it("who gets the lead, and which teammate hears, stay as the person set them", () => {
    const person = "0190e0c0-0000-7000-8000-0000000000e1";
    const g: FlowGraph = {
      ...draft,
      nodes: [
        {
          id: "hello",
          type: "update",
          actions: [{ kind: "assign", to: { mode: "user", userId: person } }],
          next: "bye",
        },
        { id: "bye", type: "notify", to: { userId: person }, text: "New lead", next: null },
      ],
    };
    const r = buildFromAnswer(
      g,
      answer([
        step({
          id: "hello",
          type: "update",
          changes: [{ kind: "tag_add", target: TAG, value: "" }],
          next: "bye",
        }),
        step({ id: "bye", type: "notify", to: "owner", text: "A new lead" }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes[0]).toMatchObject({
      actions: [
        { kind: "assign", to: { mode: "user", userId: person } },
        { kind: "tag", tagId: TAG, add: true },
      ],
    });
    expect(r.graph.nodes[1]).toMatchObject({ to: { userId: person }, text: "A new lead" });
  });

  it("with a selection, Starts when stays where it was, and a kept step's line to a step taken out is left open", () => {
    // Only "bye" is LUME AI's to change, and the answer takes it out.
    const r = buildFromAnswer(draft, answer([], null), ctx({ selection: ["bye"] }));
    expect(r.refused).toBe(false);
    expect(r.graph.start).toBe("hello");
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["hello"]);
    expect(r.graph.nodes[0]).toMatchObject({ next: null });
    same(applyOps(draft, r.ops), r.graph);
  });

  it("an id the answer uses twice is two steps, never one written over", () => {
    const r = buildFromAnswer(
      draft,
      answer([
        step({ id: "hello", type: "message", text: "One", next: "bye" }),
        step({ id: "hello", type: "message", text: "Two" }),
        step({ id: "bye", type: "end" }),
      ]),
      ctx(),
    );
    expect(r.graph.nodes.map((n) => n.type === "message" && n.text).filter(Boolean)).toEqual(["One", "Two"]);
  });

  it("a draft already over 100 steps isn't made into an answer that keeps them all", () => {
    const big: FlowGraph = {
      v: 2,
      start: "s0",
      nodes: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, type: "end" as const })),
      pos: {},
      notes: [],
    };
    const r = buildFromAnswer(big, answer(big.nodes.map((n) => step({ id: n.id, type: "end" }))), ctx());
    expect(r.refused).toBe(true);
    expect(r.said).toContain("A flow can have at most 100 steps.");
  });
});

describe("what LUME AI is told", () => {
  it("names Instagram's limits and the business's own lists, and no lead", () => {
    const c = ctx();
    const ins = flowBuildInstructions(c);
    expect(ins).toContain("Palm Studio");
    expect(ins).toContain("3 buttons");
    expect(ins).toContain("13 quick replies");
    expect(ins).toContain("7 days");
    const input = JSON.parse(flowBuildInput(c, draft));
    expect(input.request).toBe(c.prompt);
    expect(input.tags).toEqual([{ id: TAG, label: "Hot" }]);
    expect(input.flow.steps.map((s: { id: string }) => s.id)).toEqual(["hello", "bye"]);
    expect(JSON.stringify(input)).not.toMatch(/phone|email/i);
  });

  it("the answer's shape is strict and every field required", () => {
    expect(() => flowBuildOutput.parse({ ...answer([]), extra: 1 })).toThrow();
    expect(() => flowBuildOutput.parse(answer([{ id: "x", type: "end" } as Step]))).toThrow();
  });
});

describe("review 2026-11-24: answers the builder can always save", () => {
  it("with a selection, a step added after a selected one is written, and the selected step leads to it", () => {
    const r = buildFromAnswer(
      draft,
      answer([
        step({ id: "hello", type: "message", text: "Hi there", next: "more" }),
        step({ id: "more", type: "message", text: "One more thing", next: "bye" }),
      ]),
      ctx({ selection: ["hello"] }),
    );
    expect(r.refused).toBe(false);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["hello", "bye", "n1"]);
    expect(r.graph.nodes[0]).toMatchObject({ next: "n1" });
    expect(r.graph.nodes[2]).toMatchObject({ text: "One more thing", next: "bye" });
    same(applyOps(draft, r.ops), r.graph);
  });

  it("a wait until a time of day stays that wait when LUME AI echoes it back", () => {
    const until = { until: { time: "09:00", days: [1, 2, 3, 4, 5] } };
    const g: FlowGraph = {
      ...draft,
      nodes: [msg("hello", "Hi there", "w"), { id: "w", type: "wait", for: until, next: null }],
      pos: { hello: { x: 0, y: 0 }, w: { x: 0, y: 180 } },
    };
    const echo = JSON.parse(flowBuildInput(ctx(), g)).flow.steps as Step[];
    const r = buildFromAnswer(
      g,
      answer(echo.map((s) => (s.id === "hello" ? { ...s, text: "Hello!" } : s))),
      ctx(),
    );
    expect(r.graph.nodes[1]).toEqual({ id: "w", type: "wait", for: until, next: null });
    expect(r.said).not.toContain("A wait can be");
  });

  it("a step LUME AI gives back unchanged isn't played as a change: its replies, buttons and paths keep their ids", () => {
    const g: FlowGraph = {
      ...draft,
      nodes: [
        {
          id: "hello",
          type: "message",
          text: "Which?",
          buttons: [],
          replies: [
            { id: "yes", title: "Yes", next: "bye" },
            { id: "no", title: "No", next: "bye" },
          ],
          next: "bye",
        },
        {
          id: "s",
          type: "split",
          paths: [
            { id: "a", weight: 50, next: "bye" },
            { id: "b", weight: 50, next: "bye" },
          ],
        },
        { id: "bye", type: "end" },
      ],
      pos: { hello: { x: 0, y: 0 }, s: { x: 320, y: 0 }, bye: { x: 0, y: 180 } },
    };
    const echo = JSON.parse(flowBuildInput(ctx(), g)).flow.steps as Step[];
    const r = buildFromAnswer(g, answer(echo), ctx());
    expect(r.ops).toEqual([]);
  });

  it("words past what a step can hold are cut and said; a task's due time is kept within a year", () => {
    const r = buildFromAnswer(
      empty,
      answer([
        step({
          id: "m",
          type: "message",
          text: "Pick one",
          links: [{ title: "See the full evening timetable", url: "https://palm.example/t" }],
          next: "t",
        }),
        step({ id: "t", type: "notify", to: "owner", text: "y".repeat(900), next: "u" }),
        step({
          id: "u",
          type: "update",
          changes: [{ kind: "task", target: "Call back", value: "9999999" }],
          next: "h",
        }),
        step({ id: "h", type: "handoff", to: "person", text: "z".repeat(900) }),
      ]),
      ctx(),
    );
    expect(r.refused).toBe(false);
    const [m, t, u, h] = r.graph.nodes;
    expect(m!.type === "message" && m.buttons[0]!.title).toBe("See the full evening");
    expect(t!.type === "notify" && [...t.text].length).toBe(500);
    expect(u).toMatchObject({ actions: [{ kind: "task", dueMinutes: 525_600 }] });
    expect(h?.type === "handoff" && [...(h.note ?? "")].length).toBe(500);
    expect(r.said).toContain("Instagram allows 20 characters on a button, so LUME shortened some.");
    expect(r.said).toContain("Some words were longer than a step can hold, so LUME shortened them.");
    expect(flowGraphSchema.safeParse(r.graph).success).toBe(true);
  });

  it("a flow too big to save is refused whole", () => {
    const steps = Array.from({ length: 90 }, (_, i) =>
      step({ id: `s${i}`, type: "message", text: "w".repeat(990), next: i < 89 ? `s${i + 1}` : null }),
    );
    const r = buildFromAnswer(empty, answer(steps), ctx());
    expect(r.refused).toBe(true);
    expect(r.said).toContain("This flow is too big to save.");
  });

  it("with a selection, LUME AI is asked for only the selected steps and new ones, so a big flow stays short", () => {
    expect(flowBuildInstructions(ctx({ selection: ["hello"] }))).toContain(
      "answer with only those steps (changed or not) and any new ones; every other step stays as it is",
    );
  });
});

describe("review 2026-11-24: ids and words", () => {
  it("a reply added beside one kept never takes an id that reply already has", () => {
    const g: FlowGraph = {
      ...draft,
      nodes: [
        {
          id: "hello",
          type: "message",
          text: "Which?",
          buttons: [],
          replies: [{ id: "hello-r1", title: "Yes", next: null }],
          next: null,
        },
        { id: "bye", type: "end" },
      ],
    };
    const r = buildFromAnswer(
      g,
      answer([
        step({
          id: "hello",
          type: "message",
          text: "Which?",
          options: [
            { title: "Yes", next: null },
            { title: "No", next: null },
          ],
        }),
        step({ id: "bye", type: "end" }),
      ]),
      ctx(),
    );
    const m = r.graph.nodes[0]!;
    const ids = m.type === "message" ? m.replies.map((x) => x.id) : [];
    expect(ids[0]).toBe("hello-r1");
    expect(new Set(ids).size).toBe(2);
  });

  it("a team message too long for its step is shortened, and said", () => {
    const r = buildFromAnswer(
      empty,
      answer([step({ id: "t", type: "notify", to: "owner", text: "word ".repeat(200) })]),
      ctx(),
    );
    expect(r.said).toContain("Some words were longer than a step can hold, so LUME shortened them.");
  });
});

describe("second review 2026-11-24", () => {
  it("a step given back unchanged is no change, whatever order the stored step's keys are in (jsonb)", () => {
    // Postgres keeps a jsonb object's keys shortest first: the draft as the API reads it.
    const stored = JSON.parse(
      '{"v":2,"start":"hello","nodes":[{"id":"hello","next":"bye","text":"Which?","type":"message","buttons":[],' +
        '"replies":[{"id":"yes","next":"bye","title":"Yes"}]},{"id":"bye","type":"end"}],' +
        '"pos":{"bye":{"x":0,"y":180},"hello":{"x":0,"y":0}},"notes":[]}',
    ) as FlowGraph;
    const echo = JSON.parse(flowBuildInput(ctx(), stored)).flow.steps as Step[];
    expect(buildFromAnswer(stored, answer(echo), ctx()).ops).toEqual([]);
  });

  it("a team message full of emoji is shortened to what the step holds, never refused", () => {
    const text = "Call them now 🎉 ".repeat(40);
    const r = buildFromAnswer(empty, answer([step({ id: "t", type: "notify", to: "owner", text })]), ctx());
    expect(r.refused).toBe(false);
    const t = r.graph.nodes[0]!;
    expect(t.type === "notify" && t.text.length).toBeLessThanOrEqual(500);
  });

  it("with the first step selected and taken out, Starts when goes to the step LUME AI starts with", () => {
    const r = buildFromAnswer(
      draft,
      answer([step({ id: "s1", type: "message", text: "Hi! What brings you here?", next: "bye" })], "s1"),
      ctx({ selection: ["hello"] }),
    );
    expect(r.refused).toBe(false);
    expect(r.graph.start).toBe("n1");
    expect(r.graph.nodes.map((n) => n.id)).toEqual(["bye", "n1"]);
  });

  it("a kept step's own Assign stays, within the 20 changes a step can make", () => {
    const person = "0190e0c0-0000-7000-8000-0000000000e1";
    const g: FlowGraph = {
      ...draft,
      nodes: [
        {
          id: "hello",
          type: "update",
          actions: [{ kind: "assign", to: { mode: "user", userId: person } }],
          next: null,
        },
        { id: "bye", type: "end" },
      ],
    };
    const changes = Array.from({ length: 22 }, (_, i) => ({
      kind: "task" as const,
      target: `Task ${i}`,
      value: "0",
    }));
    const r = buildFromAnswer(
      g,
      answer([step({ id: "hello", type: "update", changes }), step({ id: "bye", type: "end" })]),
      ctx(),
    );
    expect(r.refused).toBe(false);
    const u = r.graph.nodes[0]!;
    expect(u.type === "update" && u.actions.length).toBe(20);
    expect(u.type === "update" && u.actions[0]).toEqual({
      kind: "assign",
      to: { mode: "user", userId: person },
    });
    expect(r.said).toContain("A step can make at most 20 changes, so LUME kept the first 20.");
  });

  it("LUME AI is told a wait of 0 minutes is a wait until a time of day, kept as it is", () => {
    expect(flowBuildInstructions(ctx())).toContain(
      "0 on a step already in the flow waits until a time of day: keep it 0",
    );
  });
});
