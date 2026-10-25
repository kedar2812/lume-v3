import {
  autopilotFirstOutput,
  autopilotReplyOutput,
  catchUpOutput,
  isStop,
  replyMeaningOutput,
  type AiTask,
  type AutopilotReply,
  type CatchUp,
  type LeadFacts,
  type NextStep,
  type ReplyMeaning,
} from "@lume/core";
import type { AiProvider } from "./provider";

export type FakeProvider = AiProvider & {
  readonly calls: { instructions: string; input: string }[];
  /** Answers for the next reads of a task, used up in order (Autopilot A2): then the fixed answer again. */
  script(task: AiTask, outputs: unknown[]): void;
};

/** The facts in a read's input (the JSON before the note), or null. */
function factsIn(input: string): LeadFacts | null {
  try {
    const lead = (JSON.parse(input.split("\n\nThe note:\n")[0]!) as { lead?: LeadFacts }).lead;
    return lead && Array.isArray(lead.stages) ? lead : null;
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD" of the day after `now` on `tz`. */
function tomorrow(now: string, tz: string): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(now))
    .split("-")
    .map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function nextStepFor(f: LeadFacts | null): NextStep {
  const at = f ? f.stages.findIndex((s) => s.id === f.stage.id) : -1;
  const next = f?.stages.slice(at + 1).find((s) => s.kind === "open") ?? null;
  return {
    summary: "Interested, and wants to meet.",
    stageId: next?.id ?? null,
    followUp: f ? { at: `${tomorrow(f.now, f.timezone)}T11:00`, title: "Call back" } : null,
    lostReasonId: null,
    tagIds: [],
    decisionMaker: null,
  };
}

/** Autopilot's plain answers: the first template offered, or a short friendly reply that names no price or time. */
function autopilotFor(task: "autopilot_first" | "autopilot_reply", input: string): unknown {
  if (task === "autopilot_first") {
    let id: string | undefined;
    try {
      id = (JSON.parse(input) as { templates?: { id: string }[] }).templates?.[0]?.id;
    } catch {
      id = undefined;
    }
    return { templateId: id, why: "The first approved template offered." };
  }
  const plain: AutopilotReply = {
    kind: "reply",
    message: "Thanks for your message! Happy to help.",
    reason: "Replied to the lead.",
    evidence: null,
    fileIds: [],
    stageId: null,
    fields: {},
    followUp: null,
    lostReasonId: null,
  };
  // What the lead last wrote decides it, so an end-to-end run can reach every place a real one does (Autopilot A3):
  // a yes is the goal reached, a price question goes to a person, anything else gets the plain reply.
  const said = lastLeadWords(input);
  if (/\bworks for me\b/i.test(said))
    return { ...plain, kind: "converted", message: null, reason: "Agreed to meet.", evidence: said };
  if (/\b(price|cost|charge)/i.test(said))
    return {
      ...plain,
      kind: "handover",
      message: null,
      reason: "Asked about price. LUME AI hands price questions to you.",
      evidence: said,
    };
  // A longer answer, about six seconds of typing on screen: long enough to pause, or take over, mid-way.
  if (/\bphotos?\b/i.test(said))
    return {
      ...plain,
      message:
        "Here are a few photos of our recent work, from a small studio flat to a large family home. Each one shows the before and after, and what was included. Tell me which feels closest to your space and I can share more like it.",
    };
  return plain;
}

/** A reply's meaning by its words, for tests and e2e (W2): the board's groups from plain keywords. */
function meaningFor(input: string): ReplyMeaning {
  const reply = input.split("\n\nThe reply:\n")[1] ?? "";
  const t = reply.toLowerCase();
  const group: ReplyMeaning["meaning"] = isStop(reply)
    ? "stop"
    : /wrong number/.test(t)
      ? "wrong_number"
      : /not interested|no thanks/.test(t)
        ? "not_interested"
        : /price|cost|how much|kitna|kitni/.test(t)
          ? "price"
          : /visit|call|meet/.test(t)
            ? "visit_or_call"
            : /later|next month|after/.test(t)
              ? "later"
              : /yes|interested|sounds good|works/.test(t)
                ? "interested"
                : "not_sure";
  return {
    meaning: group,
    summary: reply.trim().slice(0, 140) || "The lead replied.",
    stop: group === "stop",
    stageId: null,
    followUp: null,
    lostReasonId: null,
  };
}

/** The lead's latest words in a read's input, or "". */
function lastLeadWords(input: string): string {
  try {
    const thread = (JSON.parse(input) as { thread?: { from: string; text: string }[] }).thread ?? [];
    return thread.filter((m) => m.from === "lead").at(-1)?.text ?? "";
  } catch {
    return "";
  }
}

/**
 * Fixed answers for tests and e2e (`LUME_AI_PROVIDER=fake`), never a real model: the next open stage and tomorrow
 * at 11:00 on the business's clock, or three plain catch-up lines; a test may give its own answer per task. It
 * remembers what it was asked, so a test can check what LUME sent.
 */
export function fakeProvider(answers: Partial<Record<AiTask, unknown>> = {}): FakeProvider {
  const calls: { instructions: string; input: string }[] = [];
  const scripts = new Map<AiTask, unknown[]>();
  return {
    name: "fake",
    model: "fake-1",
    calls,
    script(task, outputs) {
      scripts.set(task, [...(scripts.get(task) ?? []), ...outputs]);
    },
    async read(r) {
      calls.push({ instructions: r.instructions, input: r.input });
      r.signal.throwIfAborted();
      const s = r.schema as unknown;
      const task: AiTask =
        s === catchUpOutput
          ? "catch_up"
          : s === autopilotFirstOutput
            ? "autopilot_first"
            : s === autopilotReplyOutput
              ? "autopilot_reply"
              : s === replyMeaningOutput
                ? "reply_meaning"
                : "next_step";
      const scripted = scripts.get(task)?.shift();
      if (scripted !== undefined)
        return { output: r.schema.parse(scripted), inputTokens: 100, outputTokens: 30 };
      if (task === "reply_meaning")
        return {
          output: r.schema.parse(answers[task] ?? meaningFor(r.input)),
          inputTokens: 100,
          outputTokens: 30,
        };
      if (task === "autopilot_first" || task === "autopilot_reply")
        return {
          output: r.schema.parse(answers[task] ?? autopilotFor(task, r.input)),
          inputTokens: 100,
          outputTokens: 30,
        };
      const facts = factsIn(r.input);
      const fallback = (): NextStep | CatchUp =>
        task === "catch_up"
          ? {
              lines: [
                `${facts?.firstName ?? "This lead"} enquired and is interested.`,
                `The lead is at ${facts?.stage.name ?? "an open stage"}.`,
                "A follow-up call is due next.",
              ],
            }
          : nextStepFor(facts);
      return { output: r.schema.parse(answers[task] ?? fallback()), inputTokens: 100, outputTokens: 30 };
    },
  };
}
