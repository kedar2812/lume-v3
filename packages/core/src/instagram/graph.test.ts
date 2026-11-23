import { describe, expect, it } from "vitest";
import type { FlowStep } from "./flows";
import {
  blocking,
  exitsOf,
  flowGraphSchema,
  toGraph,
  validateGraph,
  type FlowGraph,
  type GNode,
} from "./graph";

/** Flows as a graph (plan 2026-11-23-flow-builder, Task A1): the model, its checks, and 1B's lists read as graphs. */
const magnet: FlowStep[] = [
  {
    id: "hello",
    type: "send",
    text: "Here's the guide!",
    quickReplies: [{ title: "Send it", payload: "go" }],
  },
  {
    id: "q",
    type: "ask",
    text: "Your email?",
    save: { field: "email", kind: "email" },
    fallback: "Check it?",
  },
  {
    id: "c",
    type: "condition",
    when: { on: "answer", key: "email", op: "not_empty" },
    then: [{ id: "t1", type: "tag", tagId: "t-guide", add: true }],
    else: [{ id: "h1", type: "handoff", to: "person", note: "No email" }],
  },
  { id: "w", type: "wait", minutes: 60 },
  { id: "b", type: "book", text: "Book a call", url: "https://cal.example/x" },
];
const node = (g: FlowGraph, id: string) => g.nodes.find((n) => n.id === id)!;
const words = (ps: { words: string }[]) => ps.map((p) => p.words);
const ok = { ai: false };

describe("1B's lists, read as graphs", () => {
  it("keeps every id; each step goes on to the one after; a branch's last step to what follows its condition", () => {
    const g = toGraph(magnet);
    expect(g.v).toBe(2);
    expect(g.start).toBe("hello");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["b", "c", "h1", "hello", "q", "t1", "w"]);
    expect(node(g, "hello")).toMatchObject({
      type: "message",
      next: "q",
      replies: [{ title: "Send it", next: null }],
    });
    expect(node(g, "q")).toMatchObject({
      type: "ask",
      next: "c",
      retry: "Check it?",
      noAnswer: { afterMinutes: 0, next: null },
    });
    expect(node(g, "c")).toMatchObject({ type: "check", match: "all", yes: "t1", no: "h1" });
    expect(node(g, "t1")).toMatchObject({
      type: "update",
      next: "w",
      actions: [{ kind: "tag", tagId: "t-guide", add: true }],
    });
    expect(node(g, "w")).toMatchObject({ type: "wait", for: { minutes: 60 }, next: "b" });
    expect(node(g, "b")).toMatchObject({ type: "book", next: null });
  });

  it("lays steps out top to bottom, a condition's two branches side by side", () => {
    const g = toGraph(magnet);
    expect(g.pos.hello!.y).toBeLessThan(g.pos.q!.y);
    expect(g.pos.t1!.y).toBe(g.pos.h1!.y);
    expect(g.pos.h1!.x).toBeGreaterThan(g.pos.t1!.x);
    expect(g.pos.w!.y).toBeGreaterThan(g.pos.t1!.y);
  });

  it("an empty branch goes straight on; a graph passes through unchanged; an empty list has no start", () => {
    const g = toGraph([
      { id: "c", type: "condition", when: { on: "tag", key: "x", op: "empty" }, then: [], else: [] },
      { id: "e", type: "send", text: "After" },
    ]);
    expect(node(g, "c")).toMatchObject({ yes: "e", no: "e" });
    expect(toGraph(g)).toBe(g);
    expect(toGraph([]).start).toBeNull();
  });

  it("1B's quick replies stay suggestions: the converted flow is valid and goes on as it did", () => {
    expect(blocking(validateGraph(toGraph(magnet), ok))).toEqual([]);
  });
});

describe("what stops a graph going live", () => {
  const base = (): FlowGraph => toGraph(magnet);
  const swap = (g: FlowGraph, id: string, n: Partial<GNode>) => ({
    ...g,
    nodes: g.nodes.map((x) => (x.id === id ? ({ ...x, ...n } as GNode) : x)),
  });

  it("a line to a step that isn't there; two steps with one id; no first step", () => {
    expect(words(validateGraph(swap(base(), "w", { next: "gone" } as Partial<GNode>), ok))).toContain(
      "A line leads to a step that isn't there.",
    );
    const g = base();
    expect(words(validateGraph({ ...g, nodes: [...g.nodes, g.nodes[0]!] }, ok))).toContain(
      "Two steps have the same id.",
    );
    expect(words(validateGraph({ ...g, start: null }, ok))).toEqual([
      "A flow needs at least one step after Starts when.",
    ]);
  });

  it("No answer after a deadline must lead somewhere; replies all lead somewhere or none do", () => {
    const p = validateGraph(
      swap(base(), "q", { noAnswer: { afterMinutes: 60, next: null } } as Partial<GNode>),
      ok,
    );
    expect(p).toContainEqual({
      nodeId: "q",
      words: "No answer leads nowhere.",
      fix: "Connect it to a reminder, or to Ends.",
    });
    const half = swap(base(), "hello", {
      replies: [
        { id: "r1", title: "Yes", next: "q" },
        { id: "r2", title: "No", next: null },
      ],
    } as Partial<GNode>);
    expect(words(validateGraph(half, ok))).toContain("Some replies lead nowhere.");
  });

  it("Meta's limits on a message; a split's paths add up to 100; a wait up to 7 days; a goto to a flow that's there", () => {
    const four = swap(base(), "hello", {
      replies: [],
      buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}`, url: "https://x.test" })),
    } as Partial<GNode>);
    expect(words(validateGraph(four, ok))).toContain("Instagram allows at most 3 buttons.");
    const g = base();
    const split: GNode = {
      id: "s",
      type: "split",
      paths: [
        { id: "a", weight: 60, next: "w" },
        { id: "b", weight: 30, next: "b" },
      ],
    };
    expect(words(validateGraph({ ...g, nodes: [...g.nodes, split] }, ok))).toContain(
      "A split test's paths add up to 100%.",
    );
    expect(
      words(validateGraph(swap(g, "w", { for: { minutes: 8 * 24 * 60 } } as Partial<GNode>), ok)),
    ).toContain("A wait is from 1 minute to 7 days.");
    const goto: GNode = { id: "g", type: "goto", flowId: "f-archived" };
    expect(
      words(validateGraph({ ...g, nodes: [...g.nodes, goto] }, { ai: false, flows: new Set(["f-live"]) })),
    ).toContain("Go to another flow needs a flow that's live or paused.");
  });

  it("a step nothing reaches is a warning, not a stop; over 100 steps is a stop", () => {
    const g = base();
    const lost: GNode = { id: "lost", type: "end" };
    const p = validateGraph({ ...g, nodes: [...g.nodes, lost] }, ok);
    expect(p).toContainEqual({ nodeId: "lost", words: "Nothing leads to this step.", warning: true });
    expect(blocking(p)).toEqual([]);
    const many: GNode[] = Array.from({ length: 101 }, (_, i) => ({ id: `e${i}`, type: "end" as const }));
    expect(words(validateGraph({ ...g, nodes: [...g.nodes, ...many] }, ok))).toContain(
      "A flow can have at most 100 steps.",
    );
  });

  it("a flow that goes on to itself; two choices alike; a time check with no hours", () => {
    const g = base();
    const self: GNode = { id: "g", type: "goto", flowId: "f-self" };
    expect(
      words(
        validateGraph(
          { ...g, nodes: [...g.nodes, self] },
          { ai: false, flows: new Set(["f-self"]), self: "f-self" },
        ),
      ),
    ).toContain("A flow can't go on to itself. Connect a step instead.");
    const choice: GNode = {
      id: "ch",
      type: "ask",
      text: "Which?",
      save: { field: "plan", kind: "choice" },
      choices: [
        { id: "a", title: "Pro", next: null },
        { id: "b", title: " pro ", next: null },
      ],
      retry: "Tap one.",
      next: null,
      noAnswer: { afterMinutes: 0, next: null },
    };
    expect(words(validateGraph({ ...g, nodes: [...g.nodes, choice] }, ok))).toContain(
      "Two choices say the same thing.",
    );
    const check: GNode = {
      id: "t",
      type: "check",
      match: "all",
      rules: [{ on: "time", key: "9-5", op: "is" }],
      yes: null,
      no: null,
    };
    expect(words(validateGraph({ ...g, nodes: [...g.nodes, check] }, ok))).toContain(
      "Choose the hours the check looks at.",
    );
  });

  it("every step's exits, as the run and the canvas see them", () => {
    const g = base();
    expect(exitsOf(node(g, "c"))).toEqual(["t1", "h1"]);
    expect(exitsOf(node(g, "q"))).toEqual(["c", null]);
    expect(exitsOf({ id: "x", type: "goto", flowId: "f" })).toEqual([]);
  });
});

describe("what the API takes", () => {
  it("a whole graph; never an unknown step, an unknown key, or one too big to save", () => {
    const g = toGraph(magnet);
    expect(flowGraphSchema.safeParse(g).success).toBe(true);
    expect(flowGraphSchema.safeParse({ ...g, nodes: [{ id: "x", type: "explode" }] }).success).toBe(false);
    expect(flowGraphSchema.safeParse({ ...g, nodes: [{ ...g.nodes[0], extra: 1 }] }).success).toBe(false);
    const huge = {
      ...g,
      notes: Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, x: 0, y: 0, text: "x".repeat(400) })),
    };
    expect(flowGraphSchema.safeParse(huge).success).toBe(false);
  });
});
