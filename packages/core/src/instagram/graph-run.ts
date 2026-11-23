import { matchKeyword } from "./keywords";
import {
  BOOK_BUTTON,
  readAnswer,
  stepRun,
  WORDS,
  type FlowAction,
  type FlowCtx,
  type FlowEvent,
  type FlowStep,
  type RunState,
} from "./flows";
import { GRAPH_LIMITS, isGraph, type FlowGraph, type GNode, type GraphCondition, type Next } from "./graph";
import type { IgOutMessage } from "./limits";

/**
 * One turn of a graph flow's run (plan 2026-11-23-flow-builder, Task A2): where it is, what just happened, what to do
 * now. Pure, as 1B's list interpreter is; runs steps until one needs the person (a question, quick replies that
 * branch, the private reply's wait) or time (a wait), or the run ends.
 *
 * A run can never loop forever: a step runs at most 3 times in one run (the fourth hands the person to the team), at
 * most 20 messages go in a run, and at most 100 steps run in one turn. Meta's rules hold as in 1B: the one private
 * reply after a comment, nothing outside the open window, a person always one word away.
 */
const LOOPED = "Went round 3 times; waiting for a person.";
const OFF_SCRIPT = "Didn't pick a reply";
const fold = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

/** The time of day (minutes) and weekday (0 Sunday) in a timezone. */
function clock(now: Date, tz: string | undefined) {
  let zone = tz || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC"; // a timezone the runtime doesn't know: never a crash mid-run
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), day };
}

/** The next moment it's `time` on one of `days`, in the timezone (within the coming 8 days); null when there's none. */
export function nextAt(now: Date, time: string, days: number[], tz: string | undefined): Date | null {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const want = h * 60 + m;
  const c = clock(now, tz);
  // Step a minute at a time is too slow; days are compared in the zone, minutes added to now.
  for (let d = 0; d <= 7; d++) {
    const day = (c.day + d) % 7;
    if (!days.includes(day)) continue;
    const delta = d * 1440 + (want - c.minutes);
    if (delta > 0)
      return new Date(
        now.getTime() + delta * 60_000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()),
      );
  }
  return null;
}

/** A small, stable hash: a run's split test pick never changes. */
function pick(seed: string, paths: { weight: number; next: Next }[]): Next {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const total = paths.reduce((a, p) => a + p.weight, 0) || 1;
  let roll = h % total;
  for (const p of paths) {
    if (roll < p.weight) return p.next;
    roll -= p.weight;
  }
  return paths[paths.length - 1]?.next ?? null;
}

function holds(r: GraphCondition, state: RunState, ctx: FlowCtx): boolean {
  const lead = ctx.lead;
  if (r.on === "tag") {
    const has = lead.tags.includes(r.key);
    return r.op === "empty" || r.op === "is_not" ? !has : has;
  }
  if (r.on === "time") {
    // key "HH:MM-HH:MM": inside that span of the day (an overnight span wraps past midnight).
    const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(r.key);
    if (!m) return false;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    const now = clock(ctx.now, ctx.tz).minutes;
    const inside = from <= to ? now >= from && now < to : now >= from || now < to;
    return r.op === "is_not" ? !inside : inside;
  }
  const raw =
    r.on === "answer"
      ? state.answers[r.key]
      : r.on === "stage"
        ? lead.stageId
        : r.on === "owner"
          ? lead.ownerId
          : r.on === "source"
            ? lead.sourceId
            : lead.fields[r.key];
  const v = fold(raw);
  const want = fold(r.value);
  switch (r.op) {
    case "is":
      return v === want;
    case "is_not":
      return v !== want;
    case "contains":
      return !!want && v.includes(want);
    case "empty":
      return !v;
    case "not_empty":
      return !!v;
    case "gt":
    case "lt": {
      const a = Number(v);
      const b = Number(want);
      if (!Number.isFinite(a) || !Number.isFinite(b) || v === "" || want === "") return false;
      return r.op === "gt" ? a > b : a < b;
    }
  }
}

const routed = (n: Extract<GNode, { type: "message" }>) => n.replies.some((r) => r.next !== null);
const replyPayload = (nodeId: string, replyId: string) => `qr:${nodeId}:${replyId}`;
const choicePayload = (nodeId: string, i: number) => `ask:${nodeId}:${i}`;

function messageOf(n: Extract<GNode, { type: "message" }>): IgOutMessage {
  return {
    text: n.text || null,
    ...(n.media ? { mediaUrl: `lume-file:${n.media.fileId}`, mediaKind: n.media.kind } : {}),
    ...(n.replies.length
      ? { quickReplies: n.replies.map((r) => ({ title: r.title, payload: replyPayload(n.id, r.id) })) }
      : {}),
    ...(n.buttons.length ? { buttons: n.buttons.map((b) => ({ title: b.title, url: b.url })) } : {}),
  };
}
const askOf = (n: Extract<GNode, { type: "ask" }>): IgOutMessage => ({
  text: n.text,
  ...(n.save.kind === "choice" && n.choices?.length
    ? { quickReplies: n.choices.map((c, i) => ({ title: c.title, payload: choicePayload(n.id, i) })) }
    : {}),
});

export type GraphTurn = {
  state: RunState;
  actions: FlowAction[];
  /** The steps this turn ran, by key (see stepGraph). */
  entered: string[];
  done?: { reason: string };
};

/**
 * One turn of any flow's run: a 1B list on 1B's interpreter, a graph on this one. A published version never changes,
 * so a run stays on the interpreter it started on.
 */
export function stepFlow(
  flow: FlowStep[] | FlowGraph,
  state: RunState,
  event: FlowEvent,
  ctx: FlowCtx,
): GraphTurn {
  if (isGraph(flow)) return stepGraph(flow, state, event, ctx);
  return { ...stepRun(flow, state, event, ctx), entered: [] };
}

/** Every tag, stage, person and field a graph names (checked before it goes live, as flowRefs does for a list). */
export function graphRefs(g: FlowGraph): {
  tagIds: string[];
  stageIds: string[];
  userIds: string[];
  fields: string[];
} {
  const tags = new Set<string>();
  const stages = new Set<string>();
  const users = new Set<string>();
  const fields = new Set<string>();
  for (const n of g.nodes) {
    if (n.type === "ask") fields.add(n.save.field);
    if (n.type === "check")
      for (const r of n.rules) {
        if (r.on === "tag") tags.add(r.key);
        if (r.on === "field") fields.add(r.key);
        if (r.on === "stage" && r.value) stages.add(r.value);
        if (r.on === "owner" && r.value) users.add(r.value);
      }
    if (n.type === "update")
      for (const a of n.actions) {
        if (a.kind === "tag") tags.add(a.tagId);
        if (a.kind === "stage") stages.add(a.stageId);
        if (a.kind === "field") fields.add(a.field);
        if (a.kind === "assign" && a.to.mode === "user") users.add(a.to.userId);
        if (a.kind === "assign" && a.to.mode === "round_robin") a.to.userIds.forEach((u) => users.add(u));
      }
    if (n.type === "notify" && typeof n.to === "object") users.add(n.to.userId);
    if (n.type === "handoff" && n.to === "ai" && n.goal.kind === "stage") stages.add(n.goal.stageId);
  }
  return { tagIds: [...tags], stageIds: [...stages], userIds: [...users], fields: [...fields] };
}

export function stepGraph(g: FlowGraph, state0: RunState, event: FlowEvent, ctx: FlowCtx): GraphTurn {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const state: RunState = {
    ...state0,
    answers: { ...state0.answers },
    fallbacks: [...state0.fallbacks],
    visits: { ...(state0.visits ?? {}) },
  };
  const actions: FlowAction[] = [];
  /** Each step this turn ran, in order (its key: the id, or id:visit from the second time), for numbers and Replay. */
  const entered: string[] = [];
  const end = (reason: string): GraphTurn => ({
    state: { ...state, at: null, waiting: null },
    actions,
    entered,
    done: { reason },
  });
  const handTo = (note: string) => {
    actions.push({ kind: "handoff", to: "person", note });
    return end("handed");
  };
  let privateOnly = ctx.privateReplyOnly;

  if (event.kind === "start") {
    state.at = g.start;
    state.waiting = null;
  } else if (event.kind === "message") {
    if (event.text && ctx.personWords.length && matchKeyword(event.text, ctx.personWords, "exact") !== null)
      return handTo(WORDS.askedPerson);
    const w = state.waiting;
    if (w?.for === "any") {
      state.waiting = null;
      privateOnly = false;
    } else if (w?.for === "reply") {
      const n = byId.get(w.nodeId);
      if (!n || n.type !== "message") return end(WORDS.changed);
      privateOnly = false;
      const tapped =
        n.replies.find((r) => event.payload === replyPayload(n.id, r.id)) ??
        n.replies.find((r) => fold(r.title) === fold(event.text));
      if (tapped) {
        state.waiting = null;
        state.at = tapped.next;
      } else if (n.next !== null) {
        // Words that aren't one of the replies: "anything else" goes on, if the message says where.
        state.waiting = null;
        state.at = n.next;
      } else return handTo(OFF_SCRIPT); // nowhere for other words to go: a person reads them (owner 2026-11-23)
    } else if (w?.for === "answer") {
      const n = byId.get(w.stepId);
      if (!n || n.type !== "ask") return end(WORDS.changed);
      const value = readAnswer(
        {
          id: n.id,
          type: "ask",
          text: n.text,
          save: n.save,
          fallback: n.retry,
          choices: n.choices?.map((c) => c.title) ?? [],
        },
        event.text,
        event.payload,
      );
      if (value === null) {
        if (state.fallbacks.includes(n.id)) return handTo(`Didn't answer ${n.text}`);
        if (ctx.window.state !== "open") return end(WORDS.windowGone);
        if (state.sent >= GRAPH_LIMITS.sends) return end(WORDS.tooLong);
        state.fallbacks.push(n.id);
        state.sent++;
        actions.push({
          kind: "send",
          stepKey: `${n.id}:fallback`,
          asPrivateReply: false,
          message: { text: n.retry },
        });
        return { state, actions, entered };
      }
      state.answers[n.save.field] = value;
      actions.push({ kind: "saveField", field: n.save.field, value });
      state.waiting = null;
      const chosen = n.save.kind === "choice" ? n.choices?.find((c) => c.title === value) : undefined;
      state.at = chosen?.next ?? n.next;
    } else return { state, actions, entered };
  } else {
    const w = state.waiting;
    if (w?.for === "answer" && w.until) {
      if (event.now.getTime() < Date.parse(w.until)) return { state, actions, entered };
      const n = byId.get(w.stepId);
      if (!n || n.type !== "ask") return end(WORDS.changed);
      state.waiting = null;
      state.at = n.noAnswer.next;
      if (state.at === null) return end("no answer");
    } else if (w?.for === "until") {
      if (event.now.getTime() < Date.parse(w.until)) return { state, actions, entered };
      state.waiting = null;
    } else return { state, actions, entered };
  }

  const send = (stepKey: string, message: IgOutMessage): "ok" | "stop" => {
    if (state.sent >= GRAPH_LIMITS.sends) return "stop";
    if (privateOnly) {
      actions.push({ kind: "send", stepKey, asPrivateReply: true, message });
      state.sent++;
      return "ok";
    }
    if (ctx.window.state !== "open") return "stop";
    actions.push({ kind: "send", stepKey, asPrivateReply: false, message });
    state.sent++;
    return "ok";
  };
  const sendFailed = () => (state.sent >= GRAPH_LIMITS.sends ? end(WORDS.tooLong) : end(WORDS.windowGone));

  for (let steps = 0; state.at !== null; steps++) {
    if (steps >= GRAPH_LIMITS.turnSteps) return handTo(LOOPED);
    const n = byId.get(state.at);
    if (!n) return end(WORDS.changed);
    const seen = (state.visits![n.id] ?? 0) + 1;
    if (seen > GRAPH_LIMITS.visits) return handTo(LOOPED);
    state.visits![n.id] = seen;
    const key = seen > 1 ? `${n.id}:${seen}` : n.id;
    entered.push(key);
    switch (n.type) {
      case "message": {
        if (send(key, messageOf(n)) === "stop") return sendFailed();
        if (routed(n)) {
          state.at = null;
          state.waiting = { for: "reply", nodeId: n.id };
          return { state, actions, entered };
        }
        state.at = n.next;
        if (privateOnly) {
          state.waiting = { for: "any" };
          return { state, actions, entered };
        }
        break;
      }
      case "ask": {
        if (send(key, askOf(n)) === "stop") return sendFailed();
        const until =
          n.noAnswer.afterMinutes > 0
            ? new Date(ctx.now.getTime() + n.noAnswer.afterMinutes * 60_000).toISOString()
            : null;
        state.at = null;
        state.waiting = { for: "answer", stepId: n.id, ...(until ? { until } : {}) };
        return { state, actions, entered };
      }
      case "check": {
        const results = n.rules.map((r) => holds(r, state, ctx));
        const yes = n.match === "all" ? results.every(Boolean) : results.some(Boolean);
        state.at = yes ? n.yes : n.no;
        break;
      }
      case "split":
        state.at = pick(`${ctx.seed ?? ""}:${n.id}`, n.paths);
        break;
      case "wait": {
        const until =
          "minutes" in n.for
            ? new Date(ctx.now.getTime() + n.for.minutes * 60_000)
            : nextAt(ctx.now, n.for.until.time, n.for.until.days, ctx.tz);
        if (!until || ctx.window.state !== "open" || until.getTime() > ctx.window.until.getTime())
          return end(WORDS.waitPast);
        state.at = n.next;
        state.waiting = { for: "until", until: until.toISOString() };
        return { state, actions, entered };
      }
      case "update":
        for (const a of n.actions) {
          if (a.kind === "tag") actions.push({ kind: "tag", tagId: a.tagId, add: a.add });
          else if (a.kind === "stage") actions.push({ kind: "stage", stageId: a.stageId });
          else if (a.kind === "assign") actions.push({ kind: "assign", to: a.to });
          else if (a.kind === "task")
            actions.push({ kind: "task", title: a.title, dueMinutes: a.dueMinutes });
          else if (a.value === null) actions.push({ kind: "clearField", field: a.field });
          else actions.push({ kind: "saveField", field: a.field, value: a.value });
        }
        state.at = n.next;
        break;
      case "notify":
        actions.push({ kind: "notify", to: n.to, text: n.text });
        state.at = n.next;
        break;
      case "goto":
        actions.push({ kind: "goto", flowId: n.flowId });
        return end("went to another flow");
      case "handoff":
        actions.push(
          n.to === "ai"
            ? { kind: "handoff", to: "ai", note: n.note ?? "", goal: n.goal }
            : { kind: "handoff", to: "person", note: n.note ?? "" },
        );
        return end("handed");
      case "book":
        if (send(key, { text: n.text, buttons: [{ title: BOOK_BUTTON, url: n.url }] }) === "stop")
          return sendFailed();
        state.at = n.next;
        if (privateOnly) {
          state.waiting = { for: "any" };
          return { state, actions, entered };
        }
        break;
      case "end":
        return end("finished");
    }
  }
  return end("finished");
}
