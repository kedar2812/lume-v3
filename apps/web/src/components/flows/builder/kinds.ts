import type { GNode } from "@lume/core/shared";
import type { Exit } from "./graph-edit";

/**
 * The kinds of step, in LUME's words (plan 2026-11-23-flow-builder, Global Constraints: never ManyChat's names), each
 * with a new step of that kind for the rail's Add.
 */
export type StepKind = GNode["type"];

type Kind = {
  label: string;
  /** A new step of this kind, ready to fill in. */
  make(id: string): GNode;
};

export const KINDS: Record<StepKind, Kind> = {
  message: {
    label: "Message",
    make: (id) => ({ id, type: "message", text: "", buttons: [], replies: [], next: null }),
  },
  ask: {
    label: "Ask",
    make: (id) => ({
      id,
      type: "ask",
      text: "",
      save: { field: "", kind: "text" },
      retry: "Sorry, I didn't catch that. Could you try again?",
      next: null,
      noAnswer: { afterMinutes: 0, next: null },
    }),
  },
  check: {
    label: "Check",
    make: (id) => ({ id, type: "check", match: "all", rules: [], yes: null, no: null }),
  },
  split: {
    label: "Split test",
    make: (id) => ({
      id,
      type: "split",
      paths: [
        { id: "a", weight: 50, next: null },
        { id: "b", weight: 50, next: null },
      ],
    }),
  },
  wait: {
    label: "Wait",
    make: (id) => ({ id, type: "wait", for: { minutes: 60 }, next: null }),
  },
  update: {
    label: "Update the lead",
    make: (id) => ({ id, type: "update", actions: [], next: null }),
  },
  notify: {
    label: "Tell my team",
    make: (id) => ({ id, type: "notify", to: "owner", text: "", next: null }),
  },
  goto: {
    label: "Go to another flow",
    make: (id) => ({ id, type: "goto", flowId: "" }),
  },
  handoff: {
    label: "Hand over",
    make: (id) => ({ id, type: "handoff", to: "person" }),
  },
  book: {
    label: "Book a call",
    make: (id) => ({ id, type: "book", text: "", url: "", next: null }),
  },
  end: {
    label: "Ends",
    make: (id) => ({ id, type: "end" }),
  },
};

/** The order the rail offers them. */
export const RAIL: StepKind[] = [
  "message",
  "ask",
  "check",
  "wait",
  "update",
  "split",
  "notify",
  "book",
  "handoff",
  "goto",
  "end",
];

const clip = (s: string, n = 40) => {
  const t = s.replace(/\s+/g, " ").trim();
  return [...t].length > n ? `${[...t].slice(0, n - 1).join("")}…` : t;
};

/** A step's name on its card: what it says or does, in a few words. */
export function summary(n: GNode): string {
  switch (n.type) {
    case "message":
    case "ask":
      return clip(n.text) || (n.type === "ask" ? "A question" : "A message");
    case "check":
      return n.rules.length
        ? `${n.rules.length} ${n.rules.length === 1 ? "rule" : "rules"}, ${n.match === "all" ? "all" : "any"}`
        : "Choose what to check";
    case "split":
      return `${n.paths.length} paths`;
    case "wait":
      return "minutes" in n.for ? waitWords(n.for.minutes) : `Until ${n.for.until.time}`;
    case "update":
      return n.actions.length
        ? `${n.actions.length} ${n.actions.length === 1 ? "change" : "changes"}`
        : "Choose what changes";
    case "notify":
      return clip(n.text) || "Write what they're told";
    case "goto":
      return n.flowId ? "Another flow" : "Choose the flow";
    case "handoff":
      return n.to === "ai" ? "To LUME AI" : "To a person";
    case "book":
      return clip(n.text) || "A link to book";
    case "end":
      return "The flow ends";
  }
}

export function waitWords(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * A way out of a step, as what the person does to take it (owner 2026-11-28: "the information is not easily
 * understood"): "Taps “Yes please”", "Replies anything else", "No answer in 1 hour", "If yes", "70% of people", "Then".
 */
export function exitWords(n: GNode, e: Exit): string {
  const title = (t: string) => t.trim();
  if (e.key.startsWith("r:") && n.type === "message") {
    const r = n.replies.find((x) => `r:${x.id}` === e.key);
    return r && title(r.title) ? `Taps “${title(r.title)}”` : "Taps a reply";
  }
  if (e.key.startsWith("c:") && n.type === "ask") {
    const c = (n.choices ?? []).find((x) => `c:${x.id}` === e.key);
    return c && title(c.title) ? `Picks “${title(c.title)}”` : "Picks a choice";
  }
  if (e.key.startsWith("p:") && n.type === "split") {
    const p = n.paths.find((x) => `p:${x.id}` === e.key);
    return `${p?.weight ?? 0}% of people`;
  }
  if (n.type === "message" && e.key === "next")
    return n.replies.some((r) => r.next !== null) ? "Replies anything else" : "Then";
  if (n.type === "ask" && e.key === "next") return "Answers";
  if (n.type === "ask" && e.key === "noAnswer") return `No answer in ${waitWords(n.noAnswer.afterMinutes)}`;
  if (n.type === "check") return e.key === "yes" ? "If yes" : "If no";
  return "Then";
}

/** The card's second line, under its kind: only for a step whose card shows nothing more below (no repeats). */
export function headline(n: GNode): string | null {
  return n.type === "check" || n.type === "split" || n.type === "update" || n.type === "goto"
    ? summary(n)
    : null;
}
