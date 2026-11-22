import { z } from "zod";
import { matchKeyword } from "./keywords";
import type { IgOutMessage } from "./limits";
import { IG_LIMITS, messageProblems } from "./limits";
import type { IgWindow } from "./window";

/**
 * Flows (NEW_FEATURES_PLAN §4.5; plan 1B): a vertical list of steps with branches as nested lists, so a flow can't
 * loop. The interpreter is pure: (steps, run state, event) → actions and the new state. The API applies the actions,
 * one transaction per step, each keyed by run and step so nothing happens twice.
 */
type QuickReply = { title: string; payload: string };
type Button = { title: string; url: string };
export type FlowCondition = {
  on: "field" | "answer" | "tag";
  key: string;
  op: "is" | "contains" | "empty" | "not_empty";
  value?: string;
};
export type FlowStep =
  | { id: string; type: "send"; text: string; quickReplies?: QuickReply[]; buttons?: Button[] }
  | {
      id: string;
      type: "ask";
      text: string;
      save: { field: string; kind: "text" | "email" | "phone" | "number" | "choice" };
      choices?: string[];
      fallback: string;
    }
  | { id: string; type: "condition"; when: FlowCondition; then: FlowStep[]; else: FlowStep[] }
  | { id: string; type: "tag"; tagId: string; add: boolean }
  | { id: string; type: "stage"; stageId: string }
  | {
      id: string;
      type: "assign";
      to: { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] } | { mode: "source" };
    }
  | { id: string; type: "wait"; minutes: number }
  | { id: string; type: "handoff"; to: "person"; note?: string }
  /** LUME AI takes the lead from here with this goal (spec 2026-11-22 §2: the run holds the lead after). */
  | { id: string; type: "handoff"; to: "ai"; note?: string; goal: FlowGoal }
  /** A button to the business's own booking page (Calendly or any https link). */
  | { id: string; type: "book"; text: string; url: string };

/** The same goals a LUME AI run takes (schema autopilot RunGoal). */
export type FlowGoal =
  { kind: "stage"; stageId: string } | { kind: "reply" } | { kind: "brief"; text: string };

export type RunState = {
  /** The next step to run; null at the end. */
  at: string | null;
  waiting: null | { for: "answer"; stepId: string } | { for: "any" } | { for: "until"; until: string };
  answers: Record<string, string>;
  /** Messages this run has sent (a long flow is capped). */
  sent: number;
  /** Questions whose fallback has gone (each once). */
  fallbacks: string[];
  /** The automated-experience note went in this run. */
  noted?: boolean;
};
export const NEW_RUN: RunState = { at: null, waiting: null, answers: {}, sent: 0, fallbacks: [] };

export type FlowEvent =
  | { kind: "start"; via: "comment" | "dm" | "story" | "ad" | "welcome" }
  | { kind: "message"; text: string | null; payload?: string | null }
  | { kind: "timer"; now: Date };

export type FlowCtx = {
  now: Date;
  /** Meta's window on the conversation now. */
  window: IgWindow;
  /** Started by a comment, and the person hasn't written since: only the one private reply may go. */
  privateReplyOnly: boolean;
  lead: { tags: string[]; fields: Record<string, unknown> };
  /** Words that ask for a person (the account's setting, e.g. PERSON): any of them, alone, hands the lead over. */
  personWords: string[];
};

export type FlowAction =
  | { kind: "send"; stepKey: string; asPrivateReply: boolean; message: IgOutMessage }
  | { kind: "saveField"; field: string; value: string }
  | { kind: "tag"; tagId: string; add: boolean }
  | { kind: "stage"; stageId: string }
  | { kind: "assign"; to: Extract<FlowStep, { type: "assign" }>["to"] }
  | { kind: "handoff"; to: "person"; note: string }
  | { kind: "handoff"; to: "ai"; note: string; goal: FlowGoal };

/** A flow's own limits; Meta's message limits live in IG_LIMITS. Waits are in minutes, up to 7 days. */
export const FLOW_LIMITS = {
  steps: 50,
  depth: 5,
  sends: 20,
  choices: IG_LIMITS.quickReplies,
  answerChars: 500,
  waitMinutes: 7 * 24 * 60,
} as const;
/** The booking step's button (Meta: 20 characters at most for a button's words in a DM template). */
export const BOOK_BUTTON = "Book a call";
const WORDS = {
  windowGone: "Instagram's time to reply ran out before this step.",
  waitPast: "Instagram's time to reply would run out during this wait.",
  changed: "This flow changed while the conversation was in it.",
  tooLong: "This flow sent as many messages as one run may.",
  askedPerson: "Asked for a person",
};

/** Every step in the flow, with what follows each (a branch's last step is followed by what follows its condition). */
function index(steps: FlowStep[]) {
  const byId = new Map<string, FlowStep>();
  const next = new Map<string, string | null>();
  const walk = (list: FlowStep[], after: string | null) => {
    list.forEach((s, i) => {
      byId.set(s.id, s);
      const follow = list[i + 1]?.id ?? after;
      next.set(s.id, follow);
      if (s.type === "condition") {
        walk(s.then, follow);
        walk(s.else, follow);
      }
    });
  };
  walk(steps, null);
  return { byId, next: (id: string) => next.get(id) ?? null };
}

const fold = (v: unknown) =>
  typeof v === "string"
    ? v.trim().toLowerCase()
    : v === null || v === undefined
      ? ""
      : String(v).toLowerCase();
function holds(c: FlowCondition, state: RunState, lead: FlowCtx["lead"]): boolean {
  if (c.on === "tag") {
    const has = lead.tags.includes(c.key);
    return c.op === "empty" ? !has : has;
  }
  const v = fold(c.on === "answer" ? state.answers[c.key] : lead.fields[c.key]);
  const want = fold(c.value);
  switch (c.op) {
    case "is":
      return v === want;
    case "contains":
      return !!want && v.includes(want);
    case "empty":
      return !v;
    case "not_empty":
      return !!v;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** An answer, read for its kind; null when it isn't one. */
function readAnswer(
  step: Extract<FlowStep, { type: "ask" }>,
  text: string | null,
  payload: string | null | undefined,
) {
  const t = (text ?? "").trim();
  const choices = step.choices ?? [];
  if (step.save.kind === "choice") {
    const m = payload ? /^ask:([^:]+):(\d+)$/.exec(payload) : null;
    if (m && m[1] === step.id && choices[Number(m[2])] !== undefined) return choices[Number(m[2])]!;
    return choices.find((c) => c.trim().toLowerCase() === t.toLowerCase()) ?? null;
  }
  if (!t || [...t].length > FLOW_LIMITS.answerChars) return null;
  if (step.save.kind === "email") return EMAIL.test(t) ? t.toLowerCase() : null;
  if (step.save.kind === "phone") {
    const digits = t.replace(/[\s().-]/g, "");
    return /^\+?\d{6,15}$/.test(digits) ? digits : null;
  }
  if (step.save.kind === "number") {
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n) ? String(n) : null;
  }
  return t;
}

/** What an ask step says: its words, with its choices as quick replies. */
const askMessage = (s: Extract<FlowStep, { type: "ask" }>): IgOutMessage => ({
  text: s.text,
  ...(s.save.kind === "choice" && s.choices?.length
    ? { quickReplies: s.choices.map((c, i) => ({ title: c, payload: `ask:${s.id}:${i}` })) }
    : {}),
});

/**
 * One turn of a run: where it is, what just happened, and what to do now. Runs steps until one needs the person
 * (a question, the reply a private reply waits for) or time (a wait), or the run ends. Never sends outside Meta's open
 * window; after a comment, only the one private reply, then it waits for the person to write or tap.
 */
export function stepRun(
  steps: FlowStep[],
  state0: RunState,
  event: FlowEvent,
  ctx: FlowCtx,
): { state: RunState; actions: FlowAction[]; done?: { reason: string } } {
  const { byId, next } = index(steps);
  const state: RunState = { ...state0, answers: { ...state0.answers }, fallbacks: [...state0.fallbacks] };
  const actions: FlowAction[] = [];
  const end = (reason: string) => ({
    state: { ...state, at: null, waiting: null },
    actions,
    done: { reason },
  });
  const handTo = (note: string) => {
    actions.push({ kind: "handoff", to: "person", note });
    return end("handed");
  };
  let privateOnly = ctx.privateReplyOnly;

  if (event.kind === "start") {
    state.at = steps[0]?.id ?? null;
    state.waiting = null;
  } else if (event.kind === "message") {
    // Meta's automated-experience rule: a person is always one word away, at any point of the run.
    if (event.text && ctx.personWords.length && matchKeyword(event.text, ctx.personWords, "exact") !== null)
      return handTo(WORDS.askedPerson);
    const w = state.waiting;
    if (w?.for === "any") {
      state.waiting = null;
      privateOnly = false; // they wrote: Meta's window is open now
    } else if (w?.for === "answer") {
      const step = byId.get(w.stepId);
      if (!step || step.type !== "ask") return end(WORDS.changed);
      const value = readAnswer(step, event.text, event.payload);
      if (value === null) {
        if (state.fallbacks.includes(step.id)) return handTo(`Didn't answer ${step.text}`);
        if (ctx.window.state !== "open") return end(WORDS.windowGone);
        if (state.sent >= FLOW_LIMITS.sends) return end(WORDS.tooLong);
        state.fallbacks.push(step.id);
        state.sent++;
        actions.push({
          kind: "send",
          stepKey: `${step.id}:fallback`,
          asPrivateReply: false,
          message: { text: step.fallback },
        });
        return { state, actions };
      }
      state.answers[step.save.field] = value;
      actions.push({ kind: "saveField", field: step.save.field, value });
      state.waiting = null;
      state.at = next(step.id);
    } else return { state, actions }; // running or waiting for time: a message doesn't skip a wait
  } else {
    const w = state.waiting;
    if (w?.for !== "until") return { state, actions };
    if (event.now.getTime() < Date.parse(w.until)) return { state, actions };
    state.waiting = null;
  }

  const send = (stepKey: string, message: IgOutMessage): "ok" | "stop" => {
    if (state.sent >= FLOW_LIMITS.sends) return "stop";
    if (privateOnly) {
      // The one private reply: every step that sends returns to wait for the person right after it, so it's the only one.
      actions.push({ kind: "send", stepKey, asPrivateReply: true, message });
      state.sent++;
      return "ok";
    }
    if (ctx.window.state !== "open") return "stop";
    actions.push({ kind: "send", stepKey, asPrivateReply: false, message });
    state.sent++;
    return "ok";
  };
  const sendFailed = () => (state.sent >= FLOW_LIMITS.sends ? end(WORDS.tooLong) : end(WORDS.windowGone));

  for (let guard = 0; state.at !== null && guard < FLOW_LIMITS.steps * 2; guard++) {
    const step = byId.get(state.at);
    if (!step) return end(WORDS.changed);
    switch (step.type) {
      case "send": {
        const msg: IgOutMessage = {
          text: step.text,
          ...(step.quickReplies?.length ? { quickReplies: step.quickReplies } : {}),
          ...(step.buttons?.length ? { buttons: step.buttons } : {}),
        };
        if (send(step.id, msg) === "stop") return sendFailed();
        state.at = next(step.id);
        if (privateOnly) {
          state.waiting = { for: "any" };
          return { state, actions };
        }
        break;
      }
      case "ask":
        if (send(step.id, askMessage(step)) === "stop") return sendFailed();
        state.waiting = { for: "answer", stepId: step.id };
        return { state, actions };
      case "condition": {
        const branch = holds(step.when, state, ctx.lead) ? step.then : step.else;
        state.at = branch[0]?.id ?? next(step.id);
        break;
      }
      case "tag":
        actions.push({ kind: "tag", tagId: step.tagId, add: step.add });
        state.at = next(step.id);
        break;
      case "stage":
        actions.push({ kind: "stage", stageId: step.stageId });
        state.at = next(step.id);
        break;
      case "assign":
        actions.push({ kind: "assign", to: step.to });
        state.at = next(step.id);
        break;
      case "wait": {
        const until = new Date(ctx.now.getTime() + step.minutes * 60_000);
        // A wait whose end comes after Meta's window closes could never send what follows.
        if (ctx.window.state !== "open" || until.getTime() > ctx.window.until.getTime())
          return end(WORDS.waitPast);
        state.at = next(step.id);
        state.waiting = { for: "until", until: until.toISOString() };
        return { state, actions };
      }
      case "handoff":
        actions.push(
          step.to === "ai"
            ? { kind: "handoff", to: "ai", note: step.note ?? "", goal: step.goal }
            : { kind: "handoff", to: "person", note: step.note ?? "" },
        );
        return end("handed");
      case "book": {
        if (send(step.id, { text: step.text, buttons: [{ title: BOOK_BUTTON, url: step.url }] }) === "stop")
          return sendFailed();
        state.at = next(step.id);
        if (privateOnly) {
          state.waiting = { for: "any" };
          return { state, actions };
        }
        break;
      }
    }
  }
  return end("finished");
}

/** Everything wrong with a flow, in words; empty when it can be published. */
export function validateFlow(steps: FlowStep[], opts: { ai: boolean } = { ai: false }): string[] {
  if (!steps.length) return ["A flow needs at least one step."];
  const out: string[] = [];
  const ids = new Set<string>();
  let count = 0;
  let deepest = 0;
  let dup = false;
  const walk = (list: FlowStep[], depth: number) => {
    deepest = Math.max(deepest, depth);
    for (const s of list) {
      count++;
      if (ids.has(s.id)) dup = true;
      ids.add(s.id);
      if (s.type === "send")
        out.push(
          ...messageProblems({ text: s.text, quickReplies: s.quickReplies ?? [], buttons: s.buttons ?? [] }),
        );
      if (s.type === "ask") {
        out.push(...messageProblems(askMessage(s)));
        out.push(...messageProblems({ text: s.fallback }));
        if (!s.save.field.trim()) out.push("A question needs a field to save its answer in.");
        if (
          s.save.kind === "choice" &&
          ((s.choices?.length ?? 0) < 2 || (s.choices?.length ?? 0) > FLOW_LIMITS.choices)
        )
          out.push(`A choice question needs 2 to ${FLOW_LIMITS.choices} choices.`);
      }
      if (s.type === "book") {
        if (!s.url.trim()) out.push("Add the link people book a call on (https://…).");
        else out.push(...messageProblems({ text: s.text, buttons: [{ title: BOOK_BUTTON, url: s.url }] }));
      }
      if (
        s.type === "wait" &&
        (!Number.isInteger(s.minutes) || s.minutes < 1 || s.minutes > FLOW_LIMITS.waitMinutes)
      )
        out.push("A wait is from 1 minute to 7 days.");
      if (s.type === "handoff" && s.to === "ai") {
        if (!opts.ai)
          out.push("LUME AI isn't answering Instagram in this LUME yet. Hand to a person for now.");
        else if (s.goal.kind === "brief" && !s.goal.text.trim())
          out.push("Write what LUME AI should aim for.");
        else if (s.goal.kind === "stage" && !s.goal.stageId)
          out.push("Choose the stage LUME AI should aim for.");
      }
      if (s.type === "tag" && !s.tagId) out.push("Choose the tag.");
      if (s.type === "stage" && !s.stageId) out.push("Choose the stage.");
      if (s.type === "assign" && s.to.mode === "round_robin" && !s.to.userIds.length)
        out.push("Choose who shares these leads.");
      if (s.type === "condition") {
        walk(s.then, depth + 1);
        walk(s.else, depth + 1);
      }
    }
  };
  walk(steps, 0);
  if (dup) out.unshift("Two steps have the same id.");
  if (deepest > FLOW_LIMITS.depth) out.push(`Branches can go ${FLOW_LIMITS.depth} deep at most.`);
  if (count > FLOW_LIMITS.steps) out.push(`A flow can have at most ${FLOW_LIMITS.steps} steps.`);
  return [...new Set(out)];
}

/**
 * The shape of a flow as the API takes it (sizes bounded, so a huge body is refused before validateFlow reads it).
 * validateFlow then says, in words, what Meta or LUME would refuse.
 */
const idS = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const textS = z.string().max(4000);
const goalS = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stage"), stageId: z.uuid() }).strict(),
  z.object({ kind: z.literal("reply") }).strict(),
  z.object({ kind: z.literal("brief"), text: z.string().max(2000) }).strict(),
]);
const conditionS = z
  .object({
    on: z.enum(["field", "answer", "tag"]),
    key: z.string().min(1).max(120),
    op: z.enum(["is", "contains", "empty", "not_empty"]),
    value: z.string().max(500).optional(),
  })
  .strict();
export const flowStepSchema: z.ZodType<FlowStep> = z.lazy(() =>
  z.union([
    z
      .object({
        id: idS,
        type: z.literal("send"),
        text: textS,
        quickReplies: z
          .array(z.object({ title: z.string().max(100), payload: z.string().min(1).max(1000) }).strict())
          .max(20)
          .optional(),
        buttons: z
          .array(z.object({ title: z.string().max(100), url: z.string().max(2000) }).strict())
          .max(5)
          .optional(),
      })
      .strict(),
    z
      .object({
        id: idS,
        type: z.literal("ask"),
        text: textS,
        save: z
          .object({
            field: z.string().max(120),
            kind: z.enum(["text", "email", "phone", "number", "choice"]),
          })
          .strict(),
        choices: z.array(z.string().max(100)).max(20).optional(),
        fallback: textS,
      })
      .strict(),
    z
      .object({
        id: idS,
        type: z.literal("condition"),
        when: conditionS,
        then: z.array(flowStepSchema).max(FLOW_LIMITS.steps),
        else: z.array(flowStepSchema).max(FLOW_LIMITS.steps),
      })
      .strict(),
    z.object({ id: idS, type: z.literal("tag"), tagId: z.uuid(), add: z.boolean() }).strict(),
    z.object({ id: idS, type: z.literal("stage"), stageId: z.uuid() }).strict(),
    z
      .object({
        id: idS,
        type: z.literal("assign"),
        to: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("user"), userId: z.uuid() }).strict(),
          z.object({ mode: z.literal("round_robin"), userIds: z.array(z.uuid()).max(100) }).strict(),
          z.object({ mode: z.literal("source") }).strict(),
        ]),
      })
      .strict(),
    z.object({ id: idS, type: z.literal("wait"), minutes: z.number().int() }).strict(),
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
    z.object({ id: idS, type: z.literal("book"), text: textS, url: z.string().max(2000) }).strict(),
  ]),
);
export const flowStepsSchema = z.array(flowStepSchema).max(FLOW_LIMITS.steps);

/** Every tag, stage and person a flow names, to check they exist before it's published. */
export function flowRefs(steps: FlowStep[]): {
  tagIds: string[];
  stageIds: string[];
  userIds: string[];
  fields: string[];
} {
  const tags = new Set<string>(),
    stages = new Set<string>(),
    users = new Set<string>(),
    fields = new Set<string>();
  const walk = (list: FlowStep[]) => {
    for (const s of list) {
      if (s.type === "tag") tags.add(s.tagId);
      if (s.type === "ask") fields.add(s.save.field);
      if (s.type === "condition" && s.when.on === "tag") tags.add(s.when.key);
      if (s.type === "condition" && s.when.on === "field") fields.add(s.when.key);
      if (s.type === "stage") stages.add(s.stageId);
      if (s.type === "handoff" && s.to === "ai" && s.goal.kind === "stage") stages.add(s.goal.stageId);
      if (s.type === "assign" && s.to.mode === "user") users.add(s.to.userId);
      if (s.type === "assign" && s.to.mode === "round_robin") s.to.userIds.forEach((u) => users.add(u));
      if (s.type === "condition") {
        walk(s.then);
        walk(s.else);
      }
    }
  };
  walk(steps);
  return { tagIds: [...tags], stageIds: [...stages], userIds: [...users], fields: [...fields] };
}
