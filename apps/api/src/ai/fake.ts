import { catchUpOutput, type AiTask, type CatchUp, type LeadFacts, type NextStep } from "@lume/core";
import type { AiProvider } from "./provider";

export type FakeProvider = AiProvider & { readonly calls: { instructions: string; input: string }[] };

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

/**
 * Fixed answers for tests and e2e (`LUME_AI_PROVIDER=fake`), never a real model: the next open stage and tomorrow
 * at 11:00 on the business's clock, or three plain catch-up lines; a test may give its own answer per task. It
 * remembers what it was asked, so a test can check what LUME sent.
 */
export function fakeProvider(answers: Partial<Record<AiTask, unknown>> = {}): FakeProvider {
  const calls: { instructions: string; input: string }[] = [];
  return {
    name: "fake",
    model: "fake-1",
    calls,
    async read(r) {
      calls.push({ instructions: r.instructions, input: r.input });
      r.signal.throwIfAborted();
      const task: AiTask = (r.schema as unknown) === catchUpOutput ? "catch_up" : "next_step";
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
