import { autopilotFirstOutput, autopilotInput, autopilotInstructions, guardFirst } from "@lume/core";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { aiCtx } from "../autopilot/engine";
import { aiStatus, runRead } from "../ai/service";
import { sendable } from "../leads/sending";
import { templateState } from "./template-send";

export type Recommendation = { pick: { submissionId: string; why: string } | null };

/**
 * Recommended by LUME AI (owner, 2026-10-31): of the approved templates this person may send this lead now, the one
 * that fits it best, with why in one line. The same read and guard as a run's first message (Autopilot A2): LUME AI
 * sees each template in this lead's words and may name only one of them. Nothing when LUME AI is off, when no template
 * has every value it needs, or when the answer names something else; the reply box then offers the list as before.
 */
export async function recommendTemplate(req: FastifyRequest, d: AppDeps, leadId: string): Promise<Recommendation> {
  const lead = await sendable(req, leadId);
  const state = await templateState(req, d, lead);
  const ready = state?.number ? state.options.filter((o) => o.missing.length === 0) : [];
  if (!ready.length || !(await aiStatus(req, d)).on) return { pick: null };
  const c = await aiCtx(
    req,
    { speakerId: req.actor!.userId, goal: { kind: "reply" } },
    lead,
    ready.map((o) => ({ id: o.submissionId, name: o.name, body: o.preview })),
  );
  const r = await runRead(req, d, {
    task: "autopilot_first",
    leadId: lead.id,
    instructions: autopilotInstructions("autopilot_first", c),
    input: autopilotInput("autopilot_first", c),
    schema: autopilotFirstOutput,
    maxOutputTokens: 300,
  });
  if ("unavailable" in r) return { pick: null };
  const id = guardFirst(
    r.output,
    ready.map((o) => o.submissionId),
  );
  const why = r.output.why.trim();
  return id ? { pick: { submissionId: id, why } } : { pick: null };
}
