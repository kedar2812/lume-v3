import {
  canOnRecord,
  cleanNextStep,
  followUpMoment,
  inputFor,
  instructionsFor,
  nextStepOutput,
  type NextStep,
} from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { forbidden, HttpError, notFound } from "../../http/errors";
import { tagIdsOf, updateLead, visibleLead } from "../leads/service";
import { moveStage } from "../leads/write";
import { createTask } from "../tasks/service";
import { leadFacts, noteText } from "./facts";
import { runRead, type AiUnavailable } from "./service";

/** What's kept on a next-step read: the cleaned suggestion, and the stage the lead was at when it was read. */
type Kept = { suggestion: NextStep; stageAtRead: string };
/** `dueAt`: the follow-up as a moment, so each person reads it on their own clock (null when there's none). */
export type NextStepRead = { read: { id: string; suggestion: NextStep; dueAt: string | null } };
export type Part = "stage" | "followUp" | "tags";

/**
 * `POST /api/v1/leads/:id/ai/next-step` (spec 2026-10-18 §5.2): LUME AI reads a note or a logged call on this lead
 * into a next step the business can apply — ids only from its own lists, a follow-up only after now.
 */
export async function suggestNextStep(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string,
  activityId: string,
): Promise<NextStepRead | AiUnavailable> {
  const lead = await visibleLead(req, leadId);
  if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  const note = await noteText(req, lead.id, activityId);
  if (!note) throw notFound("NOTE_NOT_FOUND", "That note isn't on this lead");
  const facts = await leadFacts(req, d, lead);
  const r = await runRead(req, d, {
    task: "next_step",
    leadId: lead.id,
    sourceActivityId: activityId,
    instructions: instructionsFor("next_step"),
    input: inputFor("next_step", facts, note),
    schema: nextStepOutput,
    maxOutputTokens: 2000,
    clean: (out) => cleanNextStep(out, facts),
    store: (out): Kept => ({ suggestion: out, stageAtRead: lead.stageId }),
  });
  return "unavailable" in r
    ? r
    : { read: { id: r.id, suggestion: r.output, dueAt: dueAtOf(r.output, facts.timezone) } };
}

/** The business's own zone: a suggested follow-up's "11:00" is on its clock. */
export async function businessZone(req: FastifyRequest): Promise<string> {
  return (
    (await req.db.execute<{ tz: string }>(sql`SELECT timezone AS tz FROM settings WHERE id = 1`)).rows[0]
      ?.tz ?? "UTC"
  );
}

/** A cleaned suggestion's follow-up as an ISO moment. */
export function dueAtOf(s: NextStep, tz: string): string | null {
  return s.followUp ? followUpMoment(s.followUp, tz).toISOString() : null;
}

/** A read on a lead this person can see, not yet applied or dismissed; 404 / 409 otherwise. */
async function openRead(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .select({ leadId: schema.aiReads.leadId, result: schema.aiReads.result, outcome: schema.aiReads.outcome })
    .from(schema.aiReads)
    .where(
      and(eq(schema.aiReads.id, id), eq(schema.aiReads.task, "next_step"), eq(schema.aiReads.status, "ok")),
    );
  if (!row) throw notFound("READ_NOT_FOUND", "That suggestion isn't here any more");
  const lead = await visibleLead(req, row.leadId);
  if (row.outcome) throw new HttpError(409, "ALREADY_DONE", "That suggestion was already used or dismissed.");
  return { lead, kept: row.result as Kept };
}

async function mark(req: FastifyRequest, id: string, outcome: "applied" | "dismissed") {
  // Only the first to mark it wins: a second Apply at the same moment finds it done.
  const r = await req.db
    .update(schema.aiReads)
    .set({ outcome, outcomeBy: req.actor!.userId, outcomeAt: new Date() })
    .where(and(eq(schema.aiReads.id, id), isNull(schema.aiReads.outcome)))
    .returning({ id: schema.aiReads.id });
  if (!r.length) throw new HttpError(409, "ALREADY_DONE", "That suggestion was already used or dismissed.");
}

/** The words for a part that couldn't be applied: the API's own message when it refused. */
const why = (e: unknown): string =>
  e instanceof HttpError ? e.message : "LUME couldn't do this part. Try it by hand.";

/**
 * `POST /api/v1/ai/reads/:id/apply` (§5.2, plan Review Focus 3): the parts the person kept, as the person, each on
 * its own — a part that can't be applied any more is skipped and said, and the rest still go.
 */
export async function applyRead(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  parts: Record<Part, boolean>,
): Promise<{ applied: Part[]; skipped: { part: Part; why: string }[] }> {
  const { lead, kept } = await openRead(req, id);
  await mark(req, id, "applied");
  const s = kept.suggestion;
  const applied: Part[] = [];
  const skipped: { part: Part; why: string }[] = [];
  // Each part in its own savepoint (the request's transaction is one transaction: a nested transaction() would
  // roll all of it back, scope included): a refused part is undone alone, and the next part still goes.
  const attempt = async (part: Part, run: () => Promise<void>) => {
    await req.db.execute(sql`SAVEPOINT lume_ai_part`);
    try {
      await run();
      await req.db.execute(sql`RELEASE SAVEPOINT lume_ai_part`);
      applied.push(part);
    } catch (e) {
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_ai_part`);
      if (!(e instanceof HttpError))
        req.log.warn({ err: e }, "couldn't apply a part of LUME AI's suggestion");
      skipped.push({ part, why: why(e) });
    }
  };
  if (parts.stage && s.stageId) {
    const now = await visibleLead(req, lead.id);
    if (now.stageId !== kept.stageAtRead)
      skipped.push({ part: "stage", why: "Someone moved this lead since the suggestion." });
    else
      await attempt("stage", async () => {
        await moveStage(
          req,
          now,
          { stageId: s.stageId!, ...(s.lostReasonId ? { lostReasonId: s.lostReasonId } : {}) },
          { via: "ai_suggestion" },
        );
      });
  }
  if (parts.followUp && s.followUp) {
    const due = followUpMoment(s.followUp, await businessZone(req));
    if (due.getTime() <= d.clock().getTime())
      skipped.push({ part: "followUp", why: "That time has passed. Set a new follow-up." });
    else
      await attempt("followUp", async () => {
        await createTask(
          req,
          d,
          lead.id,
          { title: s.followUp!.title, due: { at: due.toISOString() } },
          {
            via: "ai_suggestion",
          },
        );
      });
  }
  if (parts.tags && s.tagIds.length)
    await attempt("tags", async () => {
      const now = await visibleLead(req, lead.id);
      const have = await tagIdsOf(req, lead.id);
      await updateLead(req, lead.id, now.version, { tagIds: [...new Set([...have, ...s.tagIds])] });
    });
  return { applied, skipped };
}

/** `POST /api/v1/ai/reads/:id/dismiss`. */
export async function dismissRead(req: FastifyRequest, id: string): Promise<{ dismissed: true }> {
  await openRead(req, id);
  await mark(req, id, "dismissed");
  return { dismissed: true };
}
