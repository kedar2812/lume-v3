import { z } from "zod";
import { BOOK_BUTTON, FLOW_LIMITS, type FlowCondition, type FlowGoal, type FlowStep } from "./flows";
import { IG_LIMITS, messageProblems } from "./limits";

/**
 * Flows as a graph (plan 2026-11-23-flow-builder, Part A): steps placed anywhere on the builder's canvas, each with its
 * own exits, so any button, answer or branch can lead to any step, including back. 1B's lists read as graphs with the
 * same step ids (toGraph), so a run that started on a list carries on. Kept in the same jsonb as 1B's lists, marked
 * `v: 2`.
 */

/** Where an exit leads: a step's id, or nowhere (the run ends there). */
export type Next = string | null;
export type GraphCondition = Omit<FlowCondition, "on" | "op"> & {
  on: FlowCondition["on"] | "stage" | "owner" | "source" | "time";
  op: FlowCondition["op"] | "is_not" | "gt" | "lt";
};
export type UpdateAction =
  | { kind: "tag"; tagId: string; add: boolean }
  | { kind: "field"; field: string; value: string | null }
  | { kind: "stage"; stageId: string }
  | {
      kind: "assign";
      to: { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] } | { mode: "source" };
    }
  | { kind: "task"; title: string; dueMinutes: number };

export type GNode =
  | {
      id: string;
      type: "message";
      text: string;
      media?: { kind: "image" | "video" | "audio" | "file"; fileId: string };
      /** Links: they open a page and never branch. */
      buttons: { id: string; title: string; url: string }[];
      /** Quick replies: when any leads somewhere, the run waits for a tap and goes down that reply's line. */
      replies: { id: string; title: string; next: Next }[];
      next: Next;
    }
  | {
      id: string;
      type: "ask";
      text: string;
      save: { field: string; kind: "text" | "email" | "phone" | "number" | "choice" };
      choices?: { id: string; title: string; next: Next }[];
      /** Said once when the answer isn't one (a second miss hands the person over). */
      retry: string;
      next: Next;
      /** No answer in this long (0: no deadline) goes here. */
      noAnswer: { afterMinutes: number; next: Next };
    }
  | { id: string; type: "check"; match: "all" | "any"; rules: GraphCondition[]; yes: Next; no: Next }
  | { id: string; type: "split"; paths: { id: string; weight: number; next: Next }[] }
  | {
      id: string;
      type: "wait";
      for: { minutes: number } | { until: { time: string; days: number[] } };
      next: Next;
    }
  | { id: string; type: "update"; actions: UpdateAction[]; next: Next }
  | { id: string; type: "notify"; to: "owner" | "admins" | { userId: string }; text: string; next: Next }
  | { id: string; type: "goto"; flowId: string }
  | { id: string; type: "handoff"; to: "person"; note?: string }
  | { id: string; type: "handoff"; to: "ai"; note?: string; goal: FlowGoal }
  | { id: string; type: "book"; text: string; url: string; next: Next }
  | { id: string; type: "end" };

export type FlowGraph = {
  v: 2;
  /** The first step after the trigger. */
  start: Next;
  nodes: GNode[];
  /** Where each step sits on the canvas (canvas units). */
  pos: Record<string, { x: number; y: number }>;
  /** Notes on the canvas: never part of a run. */
  notes: { id: string; x: number; y: number; text: string }[];
};

export const GRAPH_LIMITS = {
  nodes: 100,
  splitPaths: 12,
  /** Times one step may run in one run: a loop stops on the next and waits for a person. */
  visits: 3,
  sends: FLOW_LIMITS.sends,
  turnSteps: 100,
  bytes: 50_000,
  waitMinutes: FLOW_LIMITS.waitMinutes,
} as const;

export const isGraph = (f: unknown): f is FlowGraph =>
  !!f && typeof f === "object" && !Array.isArray(f) && (f as { v?: unknown }).v === 2;

const ROW = 180;
const COL = 320;

/**
 * A 1B list as a graph: the same ids, each step's `next` the one after it (a branch's last step goes on to what follows
 * its condition), laid out top to bottom with a condition's branches side by side. A graph passes through unchanged.
 */
export function toGraph(flow: FlowStep[] | FlowGraph): FlowGraph {
  if (isGraph(flow)) return flow;
  const nodes: GNode[] = [];
  const pos: FlowGraph["pos"] = {};
  const place = (list: FlowStep[], after: Next, x: number, y: number): number => {
    let row = y;
    list.forEach((s, i) => {
      const next: Next = list[i + 1]?.id ?? after;
      pos[s.id] = { x, y: row };
      row += ROW;
      switch (s.type) {
        case "send":
          nodes.push({
            id: s.id,
            type: "message",
            text: s.text,
            buttons: (s.buttons ?? []).map((b, j) => ({ id: `${s.id}-b${j}`, title: b.title, url: b.url })),
            // 1B's quick replies never branched: kept as suggestions (no next), so the run carries on as it did.
            replies: (s.quickReplies ?? []).map((q, j) => ({
              id: `${s.id}-r${j}`,
              title: q.title,
              next: null,
            })),
            next,
          });
          break;
        case "ask":
          nodes.push({
            id: s.id,
            type: "ask",
            text: s.text,
            save: s.save,
            ...(s.choices
              ? { choices: s.choices.map((c, j) => ({ id: `${s.id}-c${j}`, title: c, next: null })) }
              : {}),
            retry: s.fallback,
            next,
            noAnswer: { afterMinutes: 0, next: null },
          });
          break;
        case "condition": {
          const yesY = row;
          const yesEnd = place(s.then, next, x, yesY);
          const noEnd = place(s.else, next, x + COL, yesY);
          row = Math.max(yesEnd, noEnd);
          nodes.push({
            id: s.id,
            type: "check",
            match: "all",
            rules: [s.when],
            yes: s.then[0]?.id ?? next,
            no: s.else[0]?.id ?? next,
          });
          break;
        }
        case "tag":
          nodes.push({
            id: s.id,
            type: "update",
            actions: [{ kind: "tag", tagId: s.tagId, add: s.add }],
            next,
          });
          break;
        case "stage":
          nodes.push({ id: s.id, type: "update", actions: [{ kind: "stage", stageId: s.stageId }], next });
          break;
        case "assign":
          nodes.push({ id: s.id, type: "update", actions: [{ kind: "assign", to: s.to }], next });
          break;
        case "wait":
          nodes.push({ id: s.id, type: "wait", for: { minutes: s.minutes }, next });
          break;
        case "handoff":
          nodes.push(s.to === "ai" ? { ...s } : { ...s });
          break;
        case "book":
          nodes.push({ id: s.id, type: "book", text: s.text, url: s.url, next });
          break;
      }
    });
    return row;
  };
  place(flow, null, 0, 0);
  return { v: 2, start: flow[0]?.id ?? null, nodes, pos, notes: [] };
}

/** Every exit of a step: where it can go next. */
export function exitsOf(n: GNode): Next[] {
  switch (n.type) {
    case "message":
      return [n.next, ...n.replies.map((r) => r.next)];
    case "ask":
      return [n.next, n.noAnswer.next, ...(n.choices ?? []).map((c) => c.next)];
    case "check":
      return [n.yes, n.no];
    case "split":
      return n.paths.map((p) => p.next);
    case "wait":
    case "update":
    case "notify":
    case "book":
      return [n.next];
    default:
      return [];
  }
}

/** A check on the time of day: "HH:MM-HH:MM" in the business's zone (an overnight span wraps past midnight). */
export const TIME_SPAN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export type Problem = { nodeId: string | null; words: string; fix?: string; warning?: boolean };

/** Words a ready-made flow leaves for the business to write: [[Your opening hours]]. Never a person's own [brackets]. */
export const FILL_IN = /\[\[\s*[^\]\s][^\]]*\]\]/;
const FILL_WORDS = "Write your own words where it says [[…]].";

/** Everything that stops a graph going live, in words, each with the step it's on; warnings don't stop it. */
export function validateGraph(
  g: FlowGraph,
  opts: { ai: boolean; flows?: Set<string>; self?: string },
): Problem[] {
  const out: Problem[] = [];
  const at = (nodeId: string | null, words: string, fix?: string) =>
    out.push({ nodeId, words, ...(fix ? { fix } : {}) });
  if (!g.nodes.length || !g.start) {
    at(null, "A flow needs at least one step after Starts when.");
    return out;
  }
  if (g.nodes.length > GRAPH_LIMITS.nodes) at(null, `A flow can have at most ${GRAPH_LIMITS.nodes} steps.`);
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) at(n.id, "Two steps have the same id.");
    ids.add(n.id);
  }
  if (!ids.has(g.start)) at(null, "Starts when leads to a step that isn't there.");
  for (const n of g.nodes) {
    // What a person reads, left as a ready-made flow wrote it: said once on the step, before Meta's own limits.
    const read =
      n.type === "message"
        ? [n.text, ...n.buttons.map((b) => b.title), ...n.replies.map((r) => r.title)]
        : n.type === "ask"
          ? [n.text, n.retry, ...(n.choices ?? []).map((c) => c.title)]
          : n.type === "book" || n.type === "notify"
            ? [n.text]
            : [];
    if (read.some((t) => FILL_IN.test(t))) at(n.id, FILL_WORDS);
    for (const e of exitsOf(n))
      if (e !== null && !ids.has(e)) at(n.id, "A line leads to a step that isn't there.");
    switch (n.type) {
      case "message": {
        const routed = n.replies.some((r) => r.next !== null);
        for (const w of messageProblems({
          text: n.text,
          ...(n.media ? { mediaUrl: `file:${n.media.fileId}`, mediaKind: n.media.kind } : {}),
          quickReplies: n.replies.map((r) => ({ title: r.title, payload: r.id })),
          buttons: n.buttons,
        }))
          at(n.id, w);
        // Meta takes 20 characters on a button: checked here, on publish, so a version already live keeps sending.
        if (n.buttons.some((b) => [...b.title.trim()].length > IG_LIMITS.buttonTitleChars))
          at(n.id, `A button's words can be at most ${IG_LIMITS.buttonTitleChars} characters.`);
        if (routed && n.replies.some((r) => r.next === null))
          at(n.id, "Some replies lead nowhere.", "Connect each reply, or none of them.");
        break;
      }
      case "ask":
        for (const w of messageProblems({ text: n.text })) at(n.id, w);
        for (const w of messageProblems({ text: n.retry })) at(n.id, w);
        if (!n.save.field.trim()) at(n.id, "A question needs a field to save its answer in.");
        if (
          n.save.kind === "choice" &&
          ((n.choices?.length ?? 0) < 2 || (n.choices?.length ?? 0) > FLOW_LIMITS.choices)
        )
          at(n.id, `A choice question needs 2 to ${FLOW_LIMITS.choices} choices.`);
        if (n.save.kind === "choice" && n.choices) {
          const titles = n.choices.map((c) => c.title.trim().toLowerCase());
          if (titles.some((t) => !t)) at(n.id, "A choice needs words.");
          else if (new Set(titles).size < titles.length) at(n.id, "Two choices say the same thing.");
        }
        if (n.noAnswer.afterMinutes > 0 && n.noAnswer.next === null)
          at(n.id, "No answer leads nowhere.", "Connect it to a reminder, or to Ends.");
        if (n.noAnswer.afterMinutes < 0 || n.noAnswer.afterMinutes > GRAPH_LIMITS.waitMinutes)
          at(n.id, "Wait for an answer from 1 minute to 7 days.");
        break;
      case "check":
        if (!n.rules.length) at(n.id, "A check needs at least one rule.");
        for (const r of n.rules) {
          if (r.on === "time" && !TIME_SPAN.test(r.key)) at(n.id, "Choose the hours the check looks at.");
          const compares = r.op !== "empty" && r.op !== "not_empty";
          if ((r.on === "stage" || r.on === "owner" || r.on === "source") && compares && !r.value)
            at(n.id, "Choose what the check compares with.");
          if ((r.on === "tag" || r.on === "field" || r.on === "answer") && !r.key)
            at(n.id, "Choose what the check looks at.");
        }
        break;
      case "split": {
        if (n.paths.length < 2 || n.paths.length > GRAPH_LIMITS.splitPaths)
          at(n.id, `A split test has 2 to ${GRAPH_LIMITS.splitPaths} paths.`);
        const total = n.paths.reduce((a, p) => a + p.weight, 0);
        if (total !== 100 || n.paths.some((p) => !Number.isInteger(p.weight) || p.weight < 1))
          at(n.id, "A split test's paths add up to 100%.");
        break;
      }
      case "wait":
        if ("minutes" in n.for) {
          if (
            !Number.isInteger(n.for.minutes) ||
            n.for.minutes < 1 ||
            n.for.minutes > GRAPH_LIMITS.waitMinutes
          )
            at(n.id, "A wait is from 1 minute to 7 days.");
        } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(n.for.until.time) || !n.for.until.days.length)
          at(n.id, "Choose the time and the days to wait until.");
        break;
      case "update":
        if (!n.actions.length) at(n.id, "Choose what to change on the lead.");
        for (const a of n.actions) {
          if (a.kind === "tag" && !a.tagId) at(n.id, "Choose the tag.");
          if (a.kind === "stage" && !a.stageId) at(n.id, "Choose the stage.");
          if (a.kind === "field" && !a.field) at(n.id, "Choose the field.");
          if (a.kind === "assign" && a.to.mode === "round_robin" && !a.to.userIds.length)
            at(n.id, "Choose who shares these leads.");
          if (a.kind === "task" && (!a.title.trim() || a.dueMinutes < 0)) at(n.id, "Give the task a title.");
        }
        break;
      case "notify":
        if (!n.text.trim()) at(n.id, "Write what your team is told.");
        break;
      case "goto":
        if (opts.self && n.flowId === opts.self)
          at(n.id, "A flow can't go on to itself. Connect a step instead.");
        else if (!n.flowId || (opts.flows && !opts.flows.has(n.flowId)))
          at(n.id, "Go to another flow needs a flow that's live or paused.");
        break;
      case "handoff":
        if (n.to === "ai") {
          if (!opts.ai)
            at(n.id, "LUME AI isn't answering Instagram in this LUME yet. Hand to a person for now.");
          else if (n.goal.kind === "brief" && !n.goal.text.trim())
            at(n.id, "Write what LUME AI should aim for.");
          else if (n.goal.kind === "stage" && !n.goal.stageId)
            at(n.id, "Choose the stage LUME AI should aim for.");
        }
        break;
      case "book":
        if (!n.url.trim()) at(n.id, "Add the link people book a call on (https://…).");
        else
          for (const w of messageProblems({ text: n.text, buttons: [{ title: BOOK_BUTTON, url: n.url }] }))
            at(n.id, w);
        break;
    }
  }
  // Steps nothing reaches: allowed (a draft in progress), said as a warning.
  const reached = new Set<string>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const walk = [g.start];
  while (walk.length) {
    const id = walk.pop();
    if (!id || reached.has(id)) continue;
    reached.add(id);
    const n = byId.get(id);
    if (n) walk.push(...exitsOf(n).filter((e): e is string => e !== null));
  }
  for (const n of g.nodes)
    if (!reached.has(n.id)) out.push({ nodeId: n.id, words: "Nothing leads to this step.", warning: true });
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.nodeId}|${p.words}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Problems that stop Publish (warnings don't). */
export const blocking = (ps: Problem[]) => ps.filter((p) => !p.warning);

const idS = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const nextS = idS.nullable();
const textS = z.string().max(4000);
const uuidS = z.uuid();
const titleS = z.string().max(80);
const goalS = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stage"), stageId: uuidS }).strict(),
  z.object({ kind: z.literal("reply") }).strict(),
  z.object({ kind: z.literal("brief"), text: z.string().max(2000) }).strict(),
]);
const ruleS = z
  .object({
    on: z.enum(["field", "answer", "tag", "stage", "owner", "source", "time"]),
    key: z.string().max(120),
    op: z.enum(["is", "is_not", "contains", "empty", "not_empty", "gt", "lt"]),
    value: z.string().max(500).optional(),
  })
  .strict();
const assignS = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("user"), userId: uuidS }).strict(),
  z.object({ mode: z.literal("round_robin"), userIds: z.array(uuidS).max(50) }).strict(),
  z.object({ mode: z.literal("source") }).strict(),
]);
const actionS = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tag"), tagId: z.string().max(64), add: z.boolean() }).strict(),
  z
    .object({ kind: z.literal("field"), field: z.string().max(120), value: z.string().max(500).nullable() })
    .strict(),
  z.object({ kind: z.literal("stage"), stageId: z.string().max(64) }).strict(),
  z.object({ kind: z.literal("assign"), to: assignS }).strict(),
  z
    .object({
      kind: z.literal("task"),
      title: z.string().max(200),
      dueMinutes: z.number().int().min(0).max(525_600),
    })
    .strict(),
]);
/** One step as the API takes it. */
export const gNodeSchema = z.union([
  z
    .object({
      id: idS,
      type: z.literal("message"),
      text: textS,
      media: z
        .object({ kind: z.enum(["image", "video", "audio", "file"]), fileId: uuidS })
        .strict()
        .optional(),
      buttons: z.array(z.object({ id: idS, title: titleS, url: z.string().max(2000) }).strict()).max(10),
      replies: z.array(z.object({ id: idS, title: titleS, next: nextS }).strict()).max(20),
      next: nextS,
    })
    .strict(),
  z
    .object({
      id: idS,
      type: z.literal("ask"),
      text: textS,
      save: z
        .object({ field: z.string().max(120), kind: z.enum(["text", "email", "phone", "number", "choice"]) })
        .strict(),
      choices: z
        .array(z.object({ id: idS, title: titleS, next: nextS }).strict())
        .max(20)
        .optional(),
      retry: textS,
      next: nextS,
      noAnswer: z
        .object({ afterMinutes: z.number().int().min(0).max(GRAPH_LIMITS.waitMinutes), next: nextS })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: idS,
      type: z.literal("check"),
      match: z.enum(["all", "any"]),
      rules: z.array(ruleS).max(20),
      yes: nextS,
      no: nextS,
    })
    .strict(),
  z
    .object({
      id: idS,
      type: z.literal("split"),
      paths: z
        .array(z.object({ id: idS, weight: z.number().int().min(0).max(100), next: nextS }).strict())
        .max(GRAPH_LIMITS.splitPaths + 4),
    })
    .strict(),
  z
    .object({
      id: idS,
      type: z.literal("wait"),
      for: z.union([
        z
          .object({
            minutes: z
              .number()
              .int()
              .min(0)
              .max(GRAPH_LIMITS.waitMinutes * 2),
          })
          .strict(),
        z
          .object({
            until: z
              .object({ time: z.string().max(5), days: z.array(z.number().int().min(0).max(6)).max(7) })
              .strict(),
          })
          .strict(),
      ]),
      next: nextS,
    })
    .strict(),
  z.object({ id: idS, type: z.literal("update"), actions: z.array(actionS).max(20), next: nextS }).strict(),
  z
    .object({
      id: idS,
      type: z.literal("notify"),
      to: z.union([z.literal("owner"), z.literal("admins"), z.object({ userId: uuidS }).strict()]),
      text: z.string().max(500),
      next: nextS,
    })
    .strict(),
  z.object({ id: idS, type: z.literal("goto"), flowId: z.string().max(64) }).strict(),
  z
    .object({
      id: idS,
      type: z.literal("handoff"),
      to: z.literal("person"),
      note: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      id: idS,
      type: z.literal("handoff"),
      to: z.literal("ai"),
      note: z.string().max(500).optional(),
      goal: goalS,
    })
    .strict(),
  z
    .object({ id: idS, type: z.literal("book"), text: textS, url: z.string().max(2000), next: nextS })
    .strict(),
  z.object({ id: idS, type: z.literal("end") }).strict(),
]);
/** The graph as the API takes it: every size bounded, so a huge body is refused before validateGraph reads it. */
export const flowGraphSchema: z.ZodType<FlowGraph> = z.lazy(() =>
  z
    .object({
      v: z.literal(2),
      start: nextS,
      nodes: z.array(gNodeSchema).max(GRAPH_LIMITS.nodes * 2),
      pos: z.record(idS, z.object({ x: z.number().finite(), y: z.number().finite() })),
      notes: z
        .array(z.object({ id: idS, x: z.number().finite(), y: z.number().finite(), text: textS }).strict())
        .max(200),
    })
    .strict()
    .refine((g) => JSON.stringify(g).length <= GRAPH_LIMITS.bytes, "This flow is too big to save."),
) as unknown as z.ZodType<FlowGraph>;
