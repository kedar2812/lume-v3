import {
  IG_WINDOW_MS,
  NEW_RUN,
  stepGraph,
  type FlowAction,
  type FlowCtx,
  type FlowEvent,
  type FlowGraph,
  type RunState,
} from "@lume/core/shared";

/**
 * The phone test (plan 2026-11-23-flow-builder, Task B3): the draft run in the browser by LUME's own interpreter, so
 * what the phone shows is what a person would get. Nothing is sent and no lead changes: what the flow would do to the
 * lead is said as a note in the chat.
 */
export type Line =
  | { from: "business"; text: string; buttons: string[]; key: string }
  | { from: "person"; text: string; key: string }
  | { from: "note"; text: string; key: string };

export type Sim = {
  state: RunState;
  lines: Line[];
  /** The quick replies on offer now (title, and what a tap sends). */
  replies: { title: string; payload: string }[];
  /** What the run is doing now, in words. */
  now: "answer" | "reply" | "message" | "wait" | "done" | "handed";
  /** When a wait ends (for Skip the wait). */
  until: Date | null;
  /** Every step the test has gone through, by id, for the canvas to light. */
  lit: string[];
  /** The test's own clock: a skipped wait moves it on. */
  clock: Date;
  /** When the person last wrote: Meta's 24 hours run from here, as they do live. */
  lastIn: Date | null;
  /** Started by a comment, and they haven't written since: only the one private reply may go. */
  privateOnly: boolean;
  ended: string | null;
};

const ctxOf = (
  sim: { clock: Date; state: RunState; lastIn: Date | null; privateOnly: boolean },
  seed: string,
): FlowCtx => {
  const until = sim.lastIn ? sim.lastIn.getTime() + IG_WINDOW_MS : null;
  return {
    now: sim.clock,
    // Meta's window as it is live: 24 hours from their last message, so a wait past it ends the test as it would a run.
    // A comment isn't a message: until they write, it's closed, and only the one private reply goes (review 2026-11-24).
    window:
      until === null
        ? { state: "closed", since: null }
        : sim.clock.getTime() < until
          ? { state: "open", until: new Date(until) }
          : { state: "closed", since: new Date(until) },
    privateReplyOnly: sim.privateOnly,
    lead: { tags: [], fields: { ...sim.state.answers } },
    // Every account's own words start as this (migration 0123); the test reads the default.
    personWords: ["PERSON"],
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    seed,
  };
};

/** What the flow does to the lead, as a note (nothing changes in a test). */
function noteOf(a: FlowAction, names: { tag(id: string): string; stage(id: string): string }): string | null {
  switch (a.kind) {
    case "tag":
      return a.add ? `Tags the lead ${names.tag(a.tagId)}` : `Takes the tag ${names.tag(a.tagId)} off`;
    case "stage":
      return `Moves the lead to ${names.stage(a.stageId)}`;
    case "assign":
      return "Gives the lead to someone on the team";
    case "saveField":
      return `Saves ${a.value} as ${a.field}`;
    case "clearField":
      return `Clears ${a.field}`;
    case "task":
      return `Makes a follow-up: ${a.title}`;
    case "notify":
      return `Tells your team: ${a.text}`;
    case "goto":
      return "Goes on to another flow";
    case "handoff":
      return a.to === "ai"
        ? "LUME AI takes the conversation"
        : "A person on your team takes the conversation";
    default:
      return null;
  }
}

let n = 0;
const key = () => `l${++n}`;

function apply(
  prev: Sim,
  turn: ReturnType<typeof stepGraph>,
  names: Parameters<typeof noteOf>[1],
  firstLines: Line[] = [],
): Sim {
  const lines = [...prev.lines, ...firstLines];
  let replies: Sim["replies"] = [];
  for (const a of turn.actions) {
    if (a.kind === "send") {
      const media = a.message.mediaUrl ? MEDIA[a.message.mediaKind ?? "file"] : null;
      lines.push({
        from: "business",
        text: [media, a.message.text].filter(Boolean).join("\n"),
        buttons: (a.message.buttons ?? []).map((b) => b.title),
        key: key(),
      });
      replies = a.message.quickReplies ?? [];
    } else {
      const note = noteOf(a, names);
      if (note) lines.push({ from: "note", text: note, key: key() });
    }
  }
  const lit = [...new Set([...prev.lit, ...turn.entered.map((k) => k.split(":")[0]!)])];
  const w = turn.state.waiting;
  const handed = turn.done?.reason === "handed";
  const now: Sim["now"] = turn.done
    ? handed
      ? "handed"
      : "done"
    : w?.for === "answer"
      ? "answer"
      : w?.for === "reply"
        ? "reply"
        : w?.for === "until"
          ? "wait"
          : "message";
  const until =
    w?.for === "until" ? new Date(w.until) : w?.for === "answer" && w.until ? new Date(w.until) : null;
  // Quick replies stay on offer only while the run waits on them.
  if (now !== "reply" && now !== "answer") replies = [];
  return {
    state: turn.state,
    lines,
    replies,
    now,
    until,
    lit,
    clock: prev.clock,
    lastIn: prev.lastIn,
    privateOnly: prev.privateOnly,
    ended: turn.done ? turn.done.reason : null,
  };
}

/** A file in a message, said in words (the test shows the flow, not the file). */
const MEDIA = { image: "[A photo]", video: "[A video]", audio: "[A voice note]", file: "[A file]" } as const;

export type Names = Parameters<typeof noteOf>[1];
const plainNames: Names = { tag: (id) => id, stage: (id) => id };

/**
 * The flow starts, as if someone had just written its keyword: in a message, or in a comment (then, as live, one
 * private reply goes and the rest waits until they write back).
 */
export function begin(
  graph: FlowGraph,
  seed: string,
  names: Names = plainNames,
  at = new Date(),
  via: "dm" | "comment" = "dm",
): Sim {
  const empty: Sim = {
    state: NEW_RUN,
    lines:
      via === "comment"
        ? [
            {
              from: "note",
              text: "Started by a comment: one private reply goes until they write back",
              key: key(),
            },
          ]
        : [],
    replies: [],
    now: "message",
    until: null,
    lit: [],
    clock: at,
    lastIn: via === "comment" ? null : at,
    privateOnly: via === "comment",
    ended: null,
  };
  const turn = stepGraph(graph, NEW_RUN, { kind: "start", via }, ctxOf(empty, seed));
  return apply(empty, turn, names);
}

/** The person writes, or taps a quick reply. */
export function say(
  sim: Sim,
  graph: FlowGraph,
  seed: string,
  text: string,
  payload?: string,
  names: Names = plainNames,
): Sim {
  if (sim.ended) return sim;
  // They wrote: Meta's 24 hours start again, and a comment's one-reply limit is over.
  const now = { ...sim, lastIn: sim.clock, privateOnly: false };
  const ev: FlowEvent = { kind: "message", text, ...(payload ? { payload } : {}) };
  const turn = stepGraph(graph, now.state, ev, ctxOf(now, seed));
  return apply(now, turn, names, [{ from: "person", text, key: key() }]);
}

/** Skip the wait (or the time a question waits for its answer): the test's clock moves on to when it ends. */
export function skip(sim: Sim, graph: FlowGraph, seed: string, names: Names = plainNames): Sim {
  if (!sim.until || sim.ended) return sim;
  // A timer is never the private reply: that goes only as the answer to the comment, as live.
  const later = { ...sim, clock: new Date(sim.until.getTime() + 1000), privateOnly: false };
  const turn = stepGraph(graph, sim.state, { kind: "timer", now: later.clock }, ctxOf(later, seed));
  return { ...apply(later, turn, names), clock: later.clock };
}
