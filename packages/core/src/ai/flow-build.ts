import { z } from "zod";
import { FLOW_LIMITS } from "../instagram/flows";
import {
  GRAPH_LIMITS,
  blocking,
  flowGraphSchema,
  exitsOf,
  validateGraph,
  type FlowGraph,
  type GNode,
  type GraphCondition,
  type Next,
  type UpdateAction,
} from "../instagram/graph";
import { IG_LIMITS } from "../instagram/limits";
import { softText } from "./fit";

/**
 * LUME AI builds a flow (plan 2026-11-23-flow-builder, Task C1). The model answers in a flat shape, every field
 * required, because a union of eleven step kinds is fragile under structured output. `buildFromAnswer` turns the
 * answer into the whole next graph, repairing what Meta's rules or this LUME can't take and saying so in one line each,
 * or refusing the answer whole; `opsBetween` turns the change into steps the builder plays with LUME AI's cursor, and
 * `applyOps` plays them. Nothing here writes: the builder saves the result like any edit.
 */

const ref = z.string().max(64);
const nextRef = ref.nullable();
const STEP_TYPES = [
  "message",
  "ask",
  "check",
  "split",
  "wait",
  "update",
  "notify",
  "handoff",
  "book",
  "end",
] as const;
const flatStep = z
  .object({
    id: ref,
    type: z.enum(STEP_TYPES),
    text: z.string().max(4000),
    links: z.array(z.object({ title: z.string().max(200), url: z.string().max(2000) }).strict()).max(20),
    options: z.array(z.object({ title: z.string().max(200), next: nextRef }).strict()).max(30),
    weights: z.array(z.number().int().min(0).max(100)).max(30),
    next: nextRef,
    otherwise: nextRef,
    save: z
      .object({ field: z.string().max(120), kind: z.enum(["text", "email", "phone", "number", "choice"]) })
      .strict()
      .nullable(),
    retry: z.string().max(4000),
    minutes: z.number().int().min(0).max(1_000_000),
    match: z.enum(["all", "any"]),
    rules: z
      .array(
        z
          .object({
            on: z.enum(["field", "answer", "tag", "stage", "owner", "source", "time"]),
            key: z.string().max(120),
            op: z.enum(["is", "is_not", "contains", "empty", "not_empty", "gt", "lt"]),
            value: z.string().max(500),
          })
          .strict(),
      )
      .max(20),
    changes: z
      .array(
        z
          .object({
            kind: z.enum(["tag_add", "tag_remove", "stage", "field", "task"]),
            target: z.string().max(200),
            value: z.string().max(500),
          })
          .strict(),
      )
      .max(20),
    to: z.enum(["owner", "admins", "person", "ai"]),
    url: z.string().max(2000),
  })
  .strict();

export const flowBuildOutput = z
  .object({
    /** What LUME AI will do, one short line a step, shown before it starts. */
    plan: z.array(softText(140, 1)).min(1).max(8),
    /** What it did, in a sentence or two. */
    said: softText(400),
    start: nextRef,
    steps: z.array(flatStep).max(GRAPH_LIMITS.nodes + 50),
  })
  .strict();
export type FlowBuildAnswer = z.infer<typeof flowBuildOutput>;
type Flat = FlowBuildAnswer["steps"][number];

export type FlowBuildCtx = {
  business: string;
  about: string;
  prompt: string;
  /** The steps the person selected: LUME AI changes only these (and adds); [] for the whole flow. */
  selection: string[];
  /** Starts when, in words. */
  trigger: string;
  stages: { id: string; name: string }[];
  tags: { id: string; label: string }[];
  /** The lead fields a step may save to or set: never a phone, email or other contact field. */
  fields: { key: string; label: string }[];
  /** LUME AI answers Instagram in this LUME (a step may hand over to it). */
  ai: boolean;
  /** Live or paused flows a kept Go to another flow may point at (for the checks). */
  flows?: Set<string>;
  self?: string;
  newId: () => string;
};

export type GraphOp =
  | { op: "add"; node: GNode; pos: { x: number; y: number } }
  /** `node: null` is Starts when; `exit` is next, yes, no, noAnswer, or a reply's, choice's or path's id. */
  | { op: "connect"; from: { node: string | null; exit: string }; to: Next }
  | { op: "edit"; node: GNode }
  | { op: "remove"; nodeId: string };

const ROW = 180;
const COL = 320;
const BOOK_URL = /^https:\/\/[^\s]+$/i;
const RETRY = "Sorry, I didn't catch that. Could you try again?";
const chars = (s: string) => [...s].length;

// ── Exits by name ────────────────────────────────────────────────────────────────────────────────────────────────

function exitEntries(n: GNode): [string, Next][] {
  switch (n.type) {
    case "message":
      return [["next", n.next], ...n.replies.map((r): [string, Next] => [r.id, r.next])];
    case "ask":
      return [
        ["next", n.next],
        ["noAnswer", n.noAnswer.next],
        ...(n.choices ?? []).map((c): [string, Next] => [c.id, c.next]),
      ];
    case "check":
      return [
        ["yes", n.yes],
        ["no", n.no],
      ];
    case "split":
      return n.paths.map((p): [string, Next] => [p.id, p.next]);
    case "wait":
    case "update":
    case "notify":
    case "book":
      return [["next", n.next]];
    default:
      return [];
  }
}

function setExit(n: GNode, exit: string, to: Next): GNode {
  switch (n.type) {
    case "message":
      return exit === "next"
        ? { ...n, next: to }
        : { ...n, replies: n.replies.map((r) => (r.id === exit ? { ...r, next: to } : r)) };
    case "ask":
      if (exit === "next") return { ...n, next: to };
      if (exit === "noAnswer") return { ...n, noAnswer: { ...n.noAnswer, next: to } };
      return n.choices
        ? { ...n, choices: n.choices.map((c) => (c.id === exit ? { ...c, next: to } : c)) }
        : n;
    case "check":
      return exit === "yes" ? { ...n, yes: to } : exit === "no" ? { ...n, no: to } : n;
    case "split":
      return { ...n, paths: n.paths.map((p) => (p.id === exit ? { ...p, next: to } : p)) };
    case "wait":
    case "update":
    case "notify":
    case "book":
      return exit === "next" ? { ...n, next: to } : n;
    default:
      return n;
  }
}

/** The step with every line that doesn't lead to one of `keep` left open. */
function openExcept(n: GNode, keep: (id: string) => boolean): GNode {
  let out = n;
  for (const [exit, to] of exitEntries(n)) if (to !== null && !keep(to)) out = setExit(out, exit, null);
  return out;
}

// ── Ops ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The ops played into `g`, in order. Positions of steps already there never move. */
export function applyOps(g: FlowGraph, ops: GraphOp[]): FlowGraph {
  let nodes = g.nodes;
  let start = g.start;
  let pos = g.pos;
  for (const o of ops) {
    switch (o.op) {
      case "add":
        nodes = [...nodes.filter((n) => n.id !== o.node.id), o.node];
        pos = { ...pos, [o.node.id]: o.pos };
        break;
      case "edit":
        nodes = nodes.map((n) => (n.id === o.node.id ? o.node : n));
        break;
      case "connect":
        if (o.from.node === null) start = o.to;
        else nodes = nodes.map((n) => (n.id === o.from.node ? setExit(n, o.from.exit, o.to) : n));
        break;
      case "remove": {
        nodes = nodes.filter((n) => n.id !== o.nodeId).map((n) => openExcept(n, (id) => id !== o.nodeId));
        if (start === o.nodeId) start = null;
        pos = Object.fromEntries(Object.entries(pos).filter(([k]) => k !== o.nodeId));
        break;
      }
    }
  }
  return { ...g, start, nodes, pos };
}

/** The same value whatever order its keys are in (a step read back from jsonb has them shortest first). */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * From `a` to `b` as the builder plays it: steps taken out first, then changed steps (lines to steps not there yet
 * left open), then each new step in the order a run meets it, each landing with its lines open and drawn once the
 * step they lead to is there. `applyOps(a, opsBetween(a, b))` is `b`.
 */
export function opsBetween(a: FlowGraph, b: FlowGraph): GraphOp[] {
  const ops: GraphOp[] = [];
  let cur = a;
  const play = (o: GraphOp) => {
    ops.push(o);
    cur = applyOps(cur, [o]);
  };
  const inB = new Map(b.nodes.map((n) => [n.id, n]));
  const inA = new Set(a.nodes.map((n) => n.id));
  for (const n of a.nodes) if (!inB.has(n.id)) play({ op: "remove", nodeId: n.id });
  const here = (id: string) => cur.nodes.some((n) => n.id === id);
  for (const n of b.nodes) {
    if (!inA.has(n.id)) continue;
    const want = openExcept(n, here);
    if (
      !same(
        cur.nodes.find((x) => x.id === n.id),
        want,
      )
    )
      play({ op: "edit", node: want });
  }
  if (cur.start !== b.start && (b.start === null || here(b.start)))
    play({ op: "connect", from: { node: null, exit: "start" }, to: b.start });
  // New steps in the order a run meets them, then any nothing reaches.
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = b.start ? [b.start] : [];
  while (walk.length) {
    const id = walk.shift()!;
    const n = inB.get(id);
    if (seen.has(id) || !n) continue;
    seen.add(id);
    order.push(id);
    walk.push(...exitsOf(n).filter((e): e is string => e !== null));
  }
  for (const n of b.nodes) if (!seen.has(n.id)) order.push(n.id);
  for (const id of order) {
    if (inA.has(id)) continue;
    const n = inB.get(id)!;
    play({ op: "add", node: openExcept(n, (to) => to === id || here(to)), pos: b.pos[id] ?? { x: 0, y: 0 } });
    if (b.start === id && cur.start !== id)
      play({ op: "connect", from: { node: null, exit: "start" }, to: id });
    for (const m of cur.nodes) {
      const want = inB.get(m.id);
      if (!want) continue;
      const wanted = new Map(exitEntries(want));
      for (const [exit, to] of exitEntries(m))
        if (wanted.get(exit) === id && to !== id) play({ op: "connect", from: { node: m.id, exit }, to: id });
    }
  }
  // Anything still apart (never expected): the step as it should be.
  for (const n of b.nodes)
    if (
      !same(
        cur.nodes.find((x) => x.id === n.id),
        n,
      )
    )
      play({ op: "edit", node: n });
  return ops;
}

// ── The answer as a graph ────────────────────────────────────────────────────────────────────────────────────────

const WORDS = {
  links: `Instagram allows ${IG_LIMITS.buttons} buttons on a message, so LUME kept the first ${IG_LIMITS.buttons}.`,
  replies: `Instagram allows ${IG_LIMITS.quickReplies} quick replies on a message, so LUME kept the first ${IG_LIMITS.quickReplies}.`,
  replyChars: `Instagram allows ${IG_LIMITS.quickReplyChars} characters on a quick reply, so LUME shortened some.`,
  both: "A message can have quick replies or buttons, not both, so LUME kept the quick replies.",
  dangling: "A line led to a step that isn't there, so LUME left it open.",
  unrouted: "Replies that led nowhere now go where their message goes next.",
  unknown: "Some changes named a tag, stage or field this LUME doesn't have, so LUME left them out.",
  noAi: "LUME AI isn't answering Instagram here yet, so LUME hands to a person instead.",
  weights: "The split test's paths didn't add up to 100%, so LUME shared them out evenly.",
  paths: `A split test has at most ${GRAPH_LIMITS.splitPaths} paths, so LUME kept the first ${GRAPH_LIMITS.splitPaths}.`,
  wait: "A wait can be from 1 minute to 7 days, so LUME kept it inside that.",
  book: "A booking step needs a link that starts with https://, so LUME made it a message.",
  choices: `A question allows ${FLOW_LIMITS.choices} choices, so LUME kept the first ${FLOW_LIMITS.choices}.`,
  buttonChars: `Instagram allows ${IG_LIMITS.buttonTitleChars} characters on a button, so LUME shortened some.`,
  long: "Some words were longer than a step can hold, so LUME shortened them.",
  actions: "A step can make at most 20 changes, so LUME kept the first 20.",
};

const TOO_BIG = "This flow is too big to save.";
/** What a step can hold (the graph's own schema): a note or a team message, a task's title, a task's due time. */
const HOLDS = { note: 500, taskTitle: 200, dueMinutes: 525_600, actions: 20 } as const;

/**
 * Ids for a step's replies, buttons, choices or paths: the ones it had, place by place, so a step given back unchanged
 * is no change; a new place gets an id none of the old ones use.
 */
function childIds(old: string[], n: number, stepId: string, tag: string): string[] {
  const used = new Set(old.slice(0, n));
  const prefix = `${stepId.slice(0, 56)}-${tag}`;
  return Array.from({ length: n }, (_, i) => {
    const had = old[i];
    if (had) return had;
    let k = i;
    while (used.has(`${prefix}${k}`)) k++;
    used.add(`${prefix}${k}`);
    return `${prefix}${k}`;
  });
}

/**
 * Cut to what a step holds as the save counts it (an emoji is two there): at a word, then a character at a time if
 * emoji still take it over, never mid-emoji.
 */
function cutUnits(t: string, max: number): string {
  let s = cutTitle(t, max);
  while (s.length > max) s = [...s].slice(0, -1).join("").trimEnd();
  return s;
}

/** Words cut to `max` characters at a word where one is near, never mid-emoji. */
function cutTitle(t: string, max: number): string {
  const s = t.trim();
  if (chars(s) <= max) return s;
  const all = [...s];
  const head = all.slice(0, max).join("");
  // Cut just before a space: the last word is whole.
  if (/\s/.test(all[max]!)) return head.trimEnd();
  const space = head.lastIndexOf(" ");
  return (space >= max / 2 ? head.slice(0, space) : head).trimEnd();
}

export type FlowBuildResult = {
  graph: FlowGraph;
  ops: GraphOp[];
  plan: string[];
  said: string;
  refused: boolean;
};

/**
 * LUME AI's answer as the next graph (C1 detail in the plan). Steps the answer names by a draft step's id are that
 * step; any other id is a new step. With a selection, steps outside it are kept exactly; without one, a draft step
 * the answer leaves out is taken out. Steps LUME AI can't write (Go to another flow) are kept as they were.
 */
export function buildFromAnswer(draft: FlowGraph, ans: FlowBuildAnswer, c: FlowBuildCtx): FlowBuildResult {
  const notes = new Set<string>();
  const refuse = (why: string): FlowBuildResult => ({
    graph: draft,
    ops: [],
    plan: ans.plan,
    said: `LUME AI couldn't make this flow work on Instagram: ${why} Nothing changed. Try asking another way.`,
    refused: true,
  });
  const drafted = new Map(draft.nodes.map((n) => [n.id, n]));
  const selected = new Set(c.selection);
  // Only a draft step is ever fixed: a step the answer adds (a fresh id) is always written (review 2026-11-24).
  const fixed = (id: string) =>
    drafted.has(id) && ((selected.size > 0 && !selected.has(id)) || drafted.get(id)?.type === "goto");

  // Every answer id to the step id it becomes: a draft step's own, or a fresh one (a repeated id is a new step).
  const idOf = new Map<string, string>();
  const steps: { flat: Flat; id: string }[] = [];
  for (const f of ans.steps) {
    const id = drafted.has(f.id) && !idOf.has(f.id) ? f.id : c.newId();
    if (!idOf.has(f.id)) idOf.set(f.id, id);
    steps.push({ flat: f, id });
  }
  const kept = new Set([...drafted.keys()].filter((id) => fixed(id) || idOf.has(id)));
  const total = new Set([...kept, ...steps.map((s) => s.id)]).size;
  if (total > GRAPH_LIMITS.nodes) return refuse(`A flow can have at most ${GRAPH_LIMITS.nodes} steps.`);
  const link = (r: string | null): Next => {
    if (r === null) return null;
    const id = idOf.get(r) ?? (drafted.has(r) && kept.has(r) ? r : null);
    // Every id it resolves to is a step in the answer or one kept: only an unknown name is open.
    if (id === null) {
      notes.add(WORDS.dangling);
      return null;
    }
    return id;
  };
  const tags = new Set(c.tags.map((t) => t.id));
  const stages = new Set(c.stages.map((s) => s.id));
  const fields = new Set(c.fields.map((f) => f.key));

  const held = (t: string) => {
    const cut = cutUnits(t, HOLDS.note);
    if (cut !== t.trim()) notes.add(WORDS.long);
    return cut;
  };
  const toNode = (f: Flat, id: string, was: GNode | undefined): GNode => {
    const next = link(f.next);
    switch (f.type) {
      case "message":
      case "book": {
        if (f.type === "book") {
          if (BOOK_URL.test(f.url.trim())) return { id, type: "book", text: f.text, url: f.url.trim(), next };
          notes.add(WORDS.book);
        }
        let links = f.links;
        let options = f.options;
        if (links.length && options.length) {
          notes.add(WORDS.both);
          links = [];
        }
        if (links.length > IG_LIMITS.buttons) {
          notes.add(WORDS.links);
          links = links.slice(0, IG_LIMITS.buttons);
        }
        if (options.length > IG_LIMITS.quickReplies) {
          notes.add(WORDS.replies);
          options = options.slice(0, IG_LIMITS.quickReplies);
        }
        const replyIds = childIds(
          was?.type === "message" ? was.replies.map((r) => r.id) : [],
          options.length,
          id,
          "r",
        );
        const buttonIds = childIds(
          was?.type === "message" ? was.buttons.map((b) => b.id) : [],
          links.length,
          id,
          "b",
        );
        let replies = options.map((o, i) => {
          const title = cutTitle(o.title, IG_LIMITS.quickReplyChars);
          if (title !== o.title.trim()) notes.add(WORDS.replyChars);
          return { id: replyIds[i]!, title, next: link(o.next) };
        });
        if (replies.some((r) => r.next !== null) && replies.some((r) => r.next === null) && next !== null) {
          notes.add(WORDS.unrouted);
          replies = replies.map((r) => (r.next === null ? { ...r, next } : r));
        }
        return {
          id,
          type: "message",
          text: f.text,
          ...(was?.type === "message" && was.media ? { media: was.media } : {}),
          buttons: links.map((l, i) => {
            const title = cutTitle(l.title, IG_LIMITS.buttonTitleChars);
            if (title !== l.title.trim()) notes.add(WORDS.buttonChars);
            return { id: buttonIds[i]!, title, url: l.url.trim() };
          }),
          replies,
          next,
        };
      }
      case "ask": {
        const kind = f.save?.kind ?? "text";
        let options = f.options;
        if (kind === "choice" && options.length > FLOW_LIMITS.choices) {
          notes.add(WORDS.choices);
          options = options.slice(0, FLOW_LIMITS.choices);
        }
        const choiceIds = childIds(
          was?.type === "ask" ? (was.choices ?? []).map((ch) => ch.id) : [],
          options.length,
          id,
          "c",
        );
        const minutes = Math.min(f.minutes, GRAPH_LIMITS.waitMinutes);
        if (minutes !== f.minutes) notes.add(WORDS.wait);
        return {
          id,
          type: "ask",
          text: f.text,
          save: { field: f.save?.field.trim() ?? "", kind },
          ...(kind === "choice"
            ? {
                choices: options.map((o, i) => {
                  const title = cutTitle(o.title, IG_LIMITS.quickReplyChars);
                  if (title !== o.title.trim()) notes.add(WORDS.replyChars);
                  return { id: choiceIds[i]!, title, next: link(o.next) };
                }),
              }
            : {}),
          retry: f.retry.trim() || RETRY,
          next,
          noAnswer: { afterMinutes: minutes, next: link(f.otherwise) },
        };
      }
      case "check": {
        const rules: GraphCondition[] = [];
        for (const r of f.rules) {
          if (r.on === "stage" && r.value && !stages.has(r.value)) {
            notes.add(WORDS.unknown);
            continue;
          }
          if (r.on === "tag" && !tags.has(r.key)) {
            notes.add(WORDS.unknown);
            continue;
          }
          rules.push({
            on: r.on,
            key: r.key,
            op: r.op,
            ...(r.value ? { value: r.value } : {}),
          } as GraphCondition);
        }
        return { id, type: "check", match: f.match, rules, yes: next, no: link(f.otherwise) };
      }
      case "split": {
        let options = f.options;
        let weights = f.weights;
        if (options.length > GRAPH_LIMITS.splitPaths) {
          notes.add(WORDS.paths);
          options = options.slice(0, GRAPH_LIMITS.splitPaths);
          weights = weights.slice(0, GRAPH_LIMITS.splitPaths);
        }
        const fair =
          weights.length === options.length &&
          weights.every((w) => w >= 1) &&
          weights.reduce((s, w) => s + w, 0) === 100;
        if (!fair && options.length) {
          notes.add(WORDS.weights);
          const base = Math.floor(100 / options.length);
          weights = options.map((_, i) => base + (i < 100 - base * options.length ? 1 : 0));
        }
        return {
          id,
          type: "split",
          paths: (() => {
            const ids = childIds(
              was?.type === "split" ? was.paths.map((p) => p.id) : [],
              options.length,
              id,
              "p",
            );
            return options.map((o, i) => ({ id: ids[i]!, weight: weights[i]!, next: link(o.next) }));
          })(),
        };
      }
      case "wait": {
        if (was?.type === "wait" && "until" in was.for && f.minutes === 0)
          return { id, type: "wait", for: was.for, next };
        const minutes = Math.max(1, Math.min(f.minutes, GRAPH_LIMITS.waitMinutes));
        if (minutes !== f.minutes) notes.add(WORDS.wait);
        return { id, type: "wait", for: { minutes }, next };
      }
      case "update": {
        const actions: UpdateAction[] = [];
        for (const ch of f.changes) {
          const target = ch.target.trim();
          if (ch.kind === "task") {
            const due = Math.max(0, Number.parseInt(ch.value, 10) || 0);
            const title = cutUnits(target, HOLDS.taskTitle);
            if (title !== target || due > HOLDS.dueMinutes) notes.add(WORDS.long);
            actions.push({ kind: "task", title, dueMinutes: Math.min(due, HOLDS.dueMinutes) });
            continue;
          }
          const known =
            ch.kind === "stage"
              ? stages.has(target)
              : ch.kind === "field"
                ? fields.has(target)
                : tags.has(target);
          if (!known) {
            notes.add(WORDS.unknown);
            continue;
          }
          actions.push(
            ch.kind === "stage"
              ? { kind: "stage", stageId: target }
              : ch.kind === "field"
                ? { kind: "field", field: target, value: ch.value.trim() || null }
                : { kind: "tag", tagId: target, add: ch.kind === "tag_add" },
          );
        }
        // Who gets the lead isn't LUME AI's to write: a kept step keeps its own.
        const own = was?.type === "update" ? was.actions.filter((a) => a.kind === "assign") : [];
        if (own.length + actions.length > HOLDS.actions) notes.add(WORDS.actions);
        return { id, type: "update", actions: [...own, ...actions].slice(0, HOLDS.actions), next };
      }
      case "notify":
        return {
          id,
          type: "notify",
          to:
            f.to === "admins"
              ? "admins"
              : was?.type === "notify" && typeof was.to === "object"
                ? was.to
                : "owner",
          text: held(f.text),
          next,
        };
      case "handoff": {
        const note = held(f.text.trim());
        if (f.to === "ai" && !c.ai) notes.add(WORDS.noAi);
        if (f.to === "ai" && c.ai)
          return {
            id,
            type: "handoff",
            to: "ai",
            ...(note ? { note } : {}),
            goal: was?.type === "handoff" && was.to === "ai" ? was.goal : { kind: "reply" },
          };
        return { id, type: "handoff", to: "person", ...(note ? { note } : {}) };
      }
      case "end":
        return { id, type: "end" };
    }
  };

  const written = new Map<string, GNode>();
  for (const s of steps) {
    if (fixed(s.id)) continue;
    written.set(s.id, toNode(s.flat, s.id, drafted.get(s.id)));
  }
  // The draft's order for steps that stay, then new ones in the answer's order.
  const nodes: GNode[] = [];
  for (const n of draft.nodes) {
    if (!kept.has(n.id)) continue;
    nodes.push(fixed(n.id) ? n : (written.get(n.id) ?? n));
  }
  for (const s of steps) if (!drafted.has(s.id)) nodes.push(written.get(s.id)!);
  const ids = new Set(nodes.map((n) => n.id));
  // A fixed step's lines to a step taken out are open, as a removal leaves them.
  const tidy = nodes.map((n) => openExcept(n, (id) => ids.has(id)));
  // With a selection Starts when stays, unless the step it went to was selected and taken out: then LUME AI's start.
  const answered = ans.start === null ? null : link(ans.start);
  const start = selected.size > 0 && (draft.start === null || ids.has(draft.start)) ? draft.start : answered;
  const next: FlowGraph = { ...draft, start, nodes: tidy, pos: place(draft, tidy, start) };

  const opts = { ai: c.ai, ...(c.flows ? { flows: c.flows } : {}), ...(c.self ? { self: c.self } : {}) };
  const before = new Set(blocking(validateGraph(draft, opts)).map((p) => `${p.nodeId}|${p.words}`));
  const touched = (id: string | null) => id === null || written.has(id);
  const fresh = blocking(validateGraph(next, opts)).filter(
    (p) => !before.has(`${p.nodeId}|${p.words}`) && touched(p.nodeId),
  );
  if (fresh.length) return refuse(fresh[0]!.words);
  const saves = flowGraphSchema.safeParse(next);
  if (!saves.success) {
    const big = saves.error.issues.some((i) => i.message === TOO_BIG);
    return refuse(big ? TOO_BIG : "A step holds more than LUME can save.");
  }

  const removed = draft.nodes.filter((n) => !ids.has(n.id)).length;
  const said = [
    ans.said.trim(),
    ...notes,
    ...(removed ? [`Took out ${removed} step${removed === 1 ? "" : "s"}.`] : []),
  ]
    .filter(Boolean)
    .join(" ");
  return { graph: next, ops: opsBetween(draft, next), plan: ans.plan, said, refused: false };
}

/**
 * Where each step sits: a step that was there keeps its place; a new one goes at its depth from Starts when (180
 * down, 320 across), moved right past any step already there.
 */
function place(draft: FlowGraph, nodes: GNode[], start: Next): FlowGraph["pos"] {
  const pos: FlowGraph["pos"] = {};
  for (const n of nodes) if (draft.pos[n.id]) pos[n.id] = draft.pos[n.id]!;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const walk: [string, number][] = start ? [[start, 0]] : [];
  while (walk.length) {
    const [id, d] = walk.shift()!;
    if (depth.has(id) || !byId.has(id)) continue;
    depth.set(id, d);
    for (const e of exitsOf(byId.get(id)!)) if (e !== null) walk.push([e, d + 1]);
  }
  const taken = (x: number, y: number) =>
    Object.values(pos).some((p) => Math.abs(p.x - x) < COL / 2 && Math.abs(p.y - y) < ROW / 2);
  const maxDepth = Math.max(-1, ...depth.values());
  let loose = maxDepth + 1;
  for (const n of nodes) {
    if (pos[n.id]) continue;
    const d = depth.get(n.id) ?? loose++;
    const y = d * ROW;
    let x = 0;
    while (taken(x, y)) x += COL;
    pos[n.id] = { x, y };
  }
  return pos;
}

// ── What LUME AI is told ─────────────────────────────────────────────────────────────────────────────────────────

/** A step as LUME AI reads and writes it (the flat shape). */
function flatOf(n: GNode): Flat {
  const base: Flat = {
    id: n.id,
    type: "end",
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
  };
  switch (n.type) {
    case "message":
      return {
        ...base,
        type: "message",
        text: n.text,
        links: n.buttons.map((b) => ({ title: b.title, url: b.url })),
        options: n.replies.map((r) => ({ title: r.title, next: r.next })),
        next: n.next,
      };
    case "ask":
      return {
        ...base,
        type: "ask",
        text: n.text,
        save: n.save,
        options: (n.choices ?? []).map((ch) => ({ title: ch.title, next: ch.next })),
        retry: n.retry,
        next: n.next,
        minutes: n.noAnswer.afterMinutes,
        otherwise: n.noAnswer.next,
      };
    case "check":
      return {
        ...base,
        type: "check",
        match: n.match,
        rules: n.rules.map((r) => ({ on: r.on, key: r.key, op: r.op, value: r.value ?? "" })),
        next: n.yes,
        otherwise: n.no,
      };
    case "split":
      return {
        ...base,
        type: "split",
        options: n.paths.map((p, i) => ({ title: `Path ${i + 1}`, next: p.next })),
        weights: n.paths.map((p) => p.weight),
      };
    case "wait":
      return { ...base, type: "wait", minutes: "minutes" in n.for ? n.for.minutes : 0, next: n.next };
    case "update":
      return {
        ...base,
        type: "update",
        changes: n.actions.flatMap((a): Flat["changes"] =>
          a.kind === "tag"
            ? [{ kind: a.add ? ("tag_add" as const) : ("tag_remove" as const), target: a.tagId, value: "" }]
            : a.kind === "stage"
              ? [{ kind: "stage" as const, target: a.stageId, value: "" }]
              : a.kind === "field"
                ? [{ kind: "field" as const, target: a.field, value: a.value ?? "" }]
                : a.kind === "task"
                  ? [{ kind: "task" as const, target: a.title, value: String(a.dueMinutes) }]
                  : [],
        ),
        next: n.next,
      };
    case "notify":
      return {
        ...base,
        type: "notify",
        to: n.to === "admins" ? "admins" : "owner",
        text: n.text,
        next: n.next,
      };
    case "handoff":
      return { ...base, type: "handoff", to: n.to, text: n.note ?? "" };
    case "book":
      return { ...base, type: "book", text: n.text, url: n.url, next: n.next };
    case "goto":
    case "end":
      return base;
  }
}

export function flowBuildInstructions(c: FlowBuildCtx): string {
  return `You build Instagram DM flows in LUME for ${c.business || "a business"}, a business that uses LUME to answer the
people who message it on Instagram.${c.about ? `\nAbout the business: ${c.about}` : ""}

A flow starts when: ${c.trigger || "the business chooses"}. It is a set of steps joined by lines. Answer with the whole flow
as it should be after the request: every step, each with its lines.

Each step has an "id": keep the id of a step that is already in the flow when you keep or change that step; give a new
step a short new id such as "s1". A line ("next", "otherwise", or an option's "next") names the id of the step it goes
to, or null to end there. "start" is the id of the first step.

Step types and the fields each uses (leave every other field empty: "", [], null or 0):
- message: "text"; "links" (at most 3 buttons, each opening a page) OR "options" (at most 13 quick replies, each at
  most 20 characters; each option's "next" is where a tap goes, or null for all of them); "next".
- ask: "text" (the question); "save" {field, kind: text, email, phone, number or choice}; for kind choice, "options"
  (2 to 13 choices, each with its own "next"); "retry" (said once when the answer isn't one); "next"; "minutes" and
  "otherwise" for where it goes when nobody answers in that many minutes (0: no deadline).
- check: "match" (all or any), "rules" [{on: field, answer, tag, stage, owner, source or time; key; op: is, is_not,
  contains, empty, not_empty, gt or lt; value}], "next" when it holds, "otherwise" when it doesn't. A tag rule's key
  and a stage rule's value are ids from the lists below.
- split: "options" (2 to 12 paths, each with its "next") and "weights" (whole percentages adding up to 100).
- wait: "minutes" (1 minute to 7 days; 0 on a step already in the flow waits until a time of day: keep it 0), "next".
- update: "changes" [{kind: tag_add, tag_remove, stage, field or task; target: a tag id, stage id, field key or a
  task's title; value: the field's new value, or a task's minutes until due}], "next".
- notify: tells the team; "to" owner or admins; "text"; "next".
- handoff: "to" person, or ai (only if LUME AI answers Instagram here: ${c.ai ? "it does" : "it doesn't"}); "text" is a
  note for whoever takes over. A handoff ends the flow.
- book: "text" and "url" (the business's booking link, https only, given by the person); "next".
- end: ends the flow.

Instagram's rules that always hold: a message is at most 1,000 characters (640 with buttons); a reply is only possible
within 24 hours of the person's last message (7 days after an ad), so keep waits short; a person can always ask for a
human. Never invent prices, offers, links or promises: use only what the request and the business say. Write in the
language of the request, short like a real DM, warm and clear.${
    c.selection.length
      ? `\n\nThe person selected the steps ${c.selection.join(", ")}: change only those, and answer with only those steps (changed or not) and any new ones; every other step stays as it is.`
      : ""
  }

"plan": what you will do, one short line a step (at most 8). "said": what you did, in a sentence or two.`;
}

export function flowBuildInput(c: FlowBuildCtx, draft: FlowGraph): string {
  return JSON.stringify({
    request: c.prompt.trim(),
    flow: { start: draft.start, steps: draft.nodes.filter((n) => n.type !== "goto").map(flatOf) },
    stages: c.stages,
    tags: c.tags,
    fields: c.fields,
  });
}
