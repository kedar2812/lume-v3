import { describe, expect, it } from "vitest";
import type { FlowGraph, GNode } from "@lume/core/shared";
import {
  addNode,
  connect,
  disconnect,
  duplicate,
  exitsOfNode,
  History,
  linesOf,
  removeNodes,
} from "./graph-edit";

/** The builder's edits (plan 2026-11-23-flow-builder, Task B1): every change a whole new graph. */
const msg = (id: string, o: Partial<Extract<GNode, { type: "message" }>> = {}): GNode => ({
  id,
  type: "message",
  text: id,
  buttons: [],
  replies: [],
  next: null,
  ...o,
});
const g0 = (): FlowGraph => ({
  v: 2,
  start: "hi",
  nodes: [
    msg("hi", {
      replies: [
        { id: "y", title: "Yes", next: "yes" },
        { id: "n", title: "No", next: null },
      ],
    }),
    msg("yes", { next: "bye" }),
    msg("bye"),
  ],
  pos: { hi: { x: 0, y: 0 }, yes: { x: 300, y: 0 }, bye: { x: 600, y: 0 } },
  notes: [],
});

describe("the builder's edits", () => {
  it("each step's exits, as the card shows them", () => {
    const g = g0();
    expect(exitsOfNode(g.nodes[0]!).map((e) => [e.key, e.label, e.to])).toEqual([
      ["r:y", "Yes", "yes"],
      ["r:n", "No", null],
      ["next", "Anything else", null],
    ]);
    expect(
      exitsOfNode({ id: "c", type: "check", match: "all", rules: [], yes: "a", no: null }).map((e) => e.key),
    ).toEqual(["yes", "no"]);
  });

  it("a line from an exit to a step; never to itself; Starts when moves the start", () => {
    let g = connect(g0(), { node: "hi", exit: "r:n" }, "bye");
    expect(linesOf(g).map((l) => l.id)).toContain("hi>r:n");
    expect(connect(g, { node: "bye", exit: "next" }, "bye")).toBe(g);
    expect(connect(g, { node: "hi", exit: "next" }, "nowhere")).toBe(g);
    g = connect(g, { node: "start", exit: "next" }, "yes");
    expect(g.start).toBe("yes");
    g = disconnect(g, { node: "yes", exit: "next" });
    expect(g.nodes[1]).toMatchObject({ next: null });
  });

  it("deleting steps takes every line into them, and Starts when's, with them", () => {
    const g = removeNodes(g0(), ["yes", "hi"]);
    expect(g.start).toBeNull();
    expect(g.nodes.map((n) => n.id)).toEqual(["bye"]);
    expect(g.pos.hi).toBeUndefined();
    const g2 = removeNodes(g0(), ["bye"]);
    expect(g2.nodes.find((n) => n.id === "yes")).toMatchObject({ next: null });
  });

  it("the first step added is where the flow starts", () => {
    const empty: FlowGraph = { v: 2, start: null, nodes: [], pos: {}, notes: [] };
    const g = addNode(empty, msg("a"), { x: 10, y: 20 });
    expect(g.start).toBe("a");
    expect(addNode(g, msg("b"), { x: 0, y: 0 }).start).toBe("a");
  });

  it("copies: lines between copied steps follow the copies, lines out stay, new ids", () => {
    let n = 0;
    const { graph, ids } = duplicate(g0(), ["hi", "yes"], () => `copy${++n}`);
    expect(ids).toEqual(["copy1", "copy2"]);
    const hi = graph.nodes.find((x) => x.id === "copy1") as Extract<GNode, { type: "message" }>;
    expect(hi.replies[0]!.next).toBe("copy2");
    const yes = graph.nodes.find((x) => x.id === "copy2") as Extract<GNode, { type: "message" }>;
    expect(yes.next).toBe("bye");
    expect(graph.pos.copy1).toEqual({ x: 40, y: 40 });
    expect(graph.start).toBe("hi");
  });

  it("a change with no Undo step of its own still ends Redo (nothing redone over new typing)", () => {
    const h = new History();
    const a = g0();
    const b = removeNodes(a, ["bye"]);
    h.push(a);
    expect(h.undo(b)).toBe(a);
    h.forgetFuture();
    expect(h.redo(a)).toBeNull();
  });

  it("undo and redo, at most a hundred steps back", () => {
    const h = new History(2);
    const a = g0();
    const b = removeNodes(a, ["bye"]);
    const c = removeNodes(b, ["yes"]);
    const d = removeNodes(c, ["hi"]);
    h.push(a);
    h.push(b);
    h.push(c);
    expect(h.undo(d)).toBe(c);
    expect(h.undo(c)).toBe(b);
    expect(h.undo(b)).toBeNull();
    expect(h.redo(b)).toBe(c);
  });
});
