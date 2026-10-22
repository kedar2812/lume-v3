import {
  autopilotFirstOutput,
  autopilotReplyOutput,
  catchUpOutput,
  type AiTask,
  type AutopilotReply,
  type CatchUp,
  type LeadFacts,
  type NextStep,
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
  return plain;
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
              : "next_step";
      const scripted = scripts.get(task)?.shift();
      if (scripted !== undefined)
        return { output: r.schema.parse(scripted), inputTokens: 100, outputTokens: 30 };
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
