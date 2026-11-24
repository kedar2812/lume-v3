import type { FlowGraph, FlowNext, GNode } from "@lume/core/shared";

/**
 * The builder's edits to a flow (plan 2026-11-23-flow-builder, Task B1), pure: the canvas shows a graph, and every
 * change is a new graph, so Undo is a list of graphs and the server always gets a whole one.
 *
 * Each step's exits have a key: "next" (goes on), "noAnswer", "yes"/"no", "r:<reply id>" (a quick reply),
 * "c:<choice id>" (a question's choice), "p:<path id>" (a split test's path).
 */
export type ExitKey = string;
export type Exit = { key: ExitKey; label: string; to: FlowNext };

/** A step's exits in the order the card shows them. */
export function exitsOfNode(n: GNode): Exit[] {
  switch (n.type) {
    case "message": {
      const out: Exit[] = n.replies.map((r) => ({ key: `r:${r.id}`, label: r.title || "Reply", to: r.next }));
      const routed = n.replies.some((r) => r.next !== null);
      out.push({ key: "next", label: routed ? "Anything else" : "Then", to: n.next });
      return out;
    }
    case "ask": {
      const out: Exit[] = (n.save.kind === "choice" ? (n.choices ?? []) : []).map((c) => ({
        key: `c:${c.id}`,
        label: c.title || "Choice",
        to: c.next,
      }));
      out.push({ key: "next", label: "Answered", to: n.next });
      if (n.noAnswer.afterMinutes > 0) out.push({ key: "noAnswer", label: "No answer", to: n.noAnswer.next });
      return out;
    }
    case "check":
      return [
        { key: "yes", label: "Yes", to: n.yes },
        { key: "no", label: "No", to: n.no },
      ];
    case "split":
      return n.paths.map((p) => ({ key: `p:${p.id}`, label: `${p.weight}%`, to: p.next }));
    case "wait":
    case "update":
    case "notify":
    case "book":
      return [{ key: "next", label: "Then", to: n.next }];
    default:
      return [];
  }
}

/** The step with one exit pointed at `to` (null: unhooked). An exit the step doesn't have changes nothing. */
export function setExit(n: GNode, key: ExitKey, to: FlowNext): GNode {
  const [kind, id] = key.includes(":") ? [key.slice(0, 2), key.slice(2)] : [key, ""];
  switch (n.type) {
    case "message":
      if (kind === "r:")
        return { ...n, replies: n.replies.map((r) => (r.id === id ? { ...r, next: to } : r)) };
      return kind === "next" ? { ...n, next: to } : n;
    case "ask":
      if (kind === "c:")
        return { ...n, choices: (n.choices ?? []).map((c) => (c.id === id ? { ...c, next: to } : c)) };
      if (kind === "noAnswer") return { ...n, noAnswer: { ...n.noAnswer, next: to } };
      return kind === "next" ? { ...n, next: to } : n;
    case "check":
      return kind === "yes" ? { ...n, yes: to } : kind === "no" ? { ...n, no: to } : n;
    case "split":
      return kind === "p:" ? { ...n, paths: n.paths.map((p) => (p.id === id ? { ...p, next: to } : p)) } : n;
    case "wait":
    case "update":
    case "notify":
    case "book":
      return kind === "next" ? { ...n, next: to } : n;
    default:
      return n;
  }
}

/** Every exit pointing at `id` unhooked (the step was deleted). */
const unhookAll = (n: GNode, id: string): GNode =>
  exitsOfNode(n).reduce((acc, e) => (e.to === id ? setExit(acc, e.key, null) : acc), n);

/** A line drawn from a step's exit to another step (or the start, from Starts when). Never to itself. */
export function connect(
  g: FlowGraph,
  from: { node: string | "start"; exit: ExitKey },
  to: string,
): FlowGraph {
  if (!g.nodes.some((n) => n.id === to)) return g;
  if (from.node === "start") return { ...g, start: to };
  if (from.node === to) return g;
  return { ...g, nodes: g.nodes.map((n) => (n.id === from.node ? setExit(n, from.exit, to) : n)) };
}

export function disconnect(g: FlowGraph, from: { node: string | "start"; exit: ExitKey }): FlowGraph {
  if (from.node === "start") return { ...g, start: null };
  return { ...g, nodes: g.nodes.map((n) => (n.id === from.node ? setExit(n, from.exit, null) : n)) };
}

/** Steps gone, and every line into them with them (Starts when too). */
export function removeNodes(g: FlowGraph, ids: string[]): FlowGraph {
  const gone = new Set(ids);
  const pos = { ...g.pos };
  for (const id of ids) delete pos[id];
  return {
    ...g,
    start: g.start && gone.has(g.start) ? null : g.start,
    nodes: g.nodes.filter((n) => !gone.has(n.id)).map((n) => ids.reduce((acc, id) => unhookAll(acc, id), n)),
    pos,
  };
}

/** A step added at a place on the canvas; the flow's first step becomes where it starts. */
export function addNode(g: FlowGraph, node: GNode, at: { x: number; y: number }): FlowGraph {
  return {
    ...g,
    start: g.start ?? (g.nodes.length === 0 ? node.id : g.start),
    nodes: [...g.nodes, node],
    pos: { ...g.pos, [node.id]: at },
  };
}

export const moveNode = (g: FlowGraph, id: string, at: { x: number; y: number }): FlowGraph => ({
  ...g,
  pos: { ...g.pos, [id]: at },
});

/** A step changed in the inspector (its id stays). */
export const replaceNode = (g: FlowGraph, node: GNode): FlowGraph => ({
  ...g,
  nodes: g.nodes.map((n) => (n.id === node.id ? node : n)),
});

/**
 * Copies of these steps, offset on the canvas, with new ids: lines between copied steps follow the copies, lines out
 * to steps not copied are kept (they still lead somewhere real), and nothing copied is where the flow starts.
 */
export function duplicate(
  g: FlowGraph,
  ids: string[],
  newId: () => string,
  offset = { x: 40, y: 40 },
): { graph: FlowGraph; ids: string[] } {
  const map = new Map(ids.map((id) => [id, newId()]));
  const remap = (to: FlowNext) => (to && map.has(to) ? map.get(to)! : to);
  const copies: GNode[] = [];
  const pos = { ...g.pos };
  for (const n of g.nodes) {
    const nid = map.get(n.id);
    if (!nid) continue;
    let c = { ...structuredClone(n), id: nid } as GNode;
    for (const e of exitsOfNode(c)) c = setExit(c, e.key, remap(e.to));
    copies.push(c);
    const p = g.pos[n.id] ?? { x: 0, y: 0 };
    pos[nid] = { x: p.x + offset.x, y: p.y + offset.y };
  }
  return { graph: { ...g, nodes: [...g.nodes, ...copies], pos }, ids: [...map.values()] };
}

/** The lines the canvas draws: one per exit that leads somewhere, plus Starts when's. */
export type Line = { id: string; from: string | "start"; exit: ExitKey; to: string; label: string };
export function linesOf(g: FlowGraph): Line[] {
  const ids = new Set(g.nodes.map((n) => n.id));
  const out: Line[] = [];
  if (g.start && ids.has(g.start))
    out.push({ id: "start>next", from: "start", exit: "next", to: g.start, label: "" });
  for (const n of g.nodes)
    for (const e of exitsOfNode(n))
      if (e.to && ids.has(e.to))
        out.push({ id: `${n.id}>${e.key}`, from: n.id, exit: e.key, to: e.to, label: e.label });
  return out;
}

/** Undo and Redo over whole graphs, at most `limit` steps back. */
export class History {
  private past: FlowGraph[] = [];
  private future: FlowGraph[] = [];
  constructor(private readonly limit = 100) {}
  push(before: FlowGraph) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  /** A change that adds no Undo step (mid-drag, mid-typing) still ends Redo: nothing redone over it. */
  forgetFuture() {
    this.future = [];
  }
  undo(now: FlowGraph): FlowGraph | null {
    const g = this.past.pop();
    if (!g) return null;
    this.future.push(now);
    return g;
  }
  redo(now: FlowGraph): FlowGraph | null {
    const g = this.future.pop();
    if (!g) return null;
    this.past.push(now);
    return g;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
