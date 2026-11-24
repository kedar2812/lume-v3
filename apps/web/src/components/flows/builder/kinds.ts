import type { GNode } from "@lume/core/shared";

/**
 * The kinds of step, in LUME's words (plan 2026-11-23-flow-builder, Global Constraints: never ManyChat's names), each
 * with its icon and a new step of that kind for the rail's Add.
 */
export type StepKind = GNode["type"];

type Kind = {
  label: string;
  /** A stroke icon on a 16×16 grid. */
  icon: string;
  /** A new step of this kind, ready to fill in. */
  make(id: string): GNode;
};

const msgIcon = "M2.5 3.5h11v7.5H6.5l-4 3z";
export const KINDS: Record<StepKind, Kind> = {
  message: {
    label: "Message",
    icon: msgIcon,
    make: (id) => ({ id, type: "message", text: "", buttons: [], replies: [], next: null }),
  },
  ask: {
    label: "Ask",
    icon: `${msgIcon}M6.6 6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9M8 9.6v.1`,
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
    icon: "M4.5 5.6v4.8M6 4h1.5a2.5 2.5 0 0 1 2.5 2.5V6.4M3 4a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
    make: (id) => ({ id, type: "check", match: "all", rules: [], yes: null, no: null }),
  },
  split: {
    label: "Split test",
    icon: "M2.5 8h4l3-4h4M6.5 8l3 4h4",
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
    icon: "M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0M8 5v3l2 1.5",
    make: (id) => ({ id, type: "wait", for: { minutes: 60 }, next: null }),
  },
  update: {
    label: "Update the lead",
    icon: "M3 12.5V10l7-7 2.5 2.5-7 7zM8.5 4.5 11 7",
    make: (id) => ({ id, type: "update", actions: [], next: null }),
  },
  notify: {
    label: "Tell my team",
    icon: "M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0",
    make: (id) => ({ id, type: "notify", to: "owner", text: "", next: null }),
  },
  goto: {
    label: "Go to another flow",
    icon: "M3 8h8M8 5l3 3-3 3M13 3v10",
    make: (id) => ({ id, type: "goto", flowId: "" }),
  },
  handoff: {
    label: "Hand over",
    icon: "M5 7.5a2 2 0 1 0 0-4a2 2 0 1 0 0 4M1.5 13a3.5 3.5 0 0 1 7 0M10 8h4.5M12.5 6l2 2-2 2",
    make: (id) => ({ id, type: "handoff", to: "person" }),
  },
  book: {
    label: "Book a call",
    icon: "M3 4.5h10v9H3zM3 7.5h10M6 3v3M10 3v3",
    make: (id) => ({ id, type: "book", text: "", url: "", next: null }),
  },
  end: {
    label: "Ends",
    icon: "M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0M5.8 8h4.4",
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
