import { catchUpOutput, inputFor, instructionsFor, type NextStep } from "@lume/core";
import { schema } from "@lume/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { visibleLead } from "../leads/service";
import { leadFacts } from "./facts";
import { aiStatus, runRead, type AiUnavailable } from "./service";

const DAY = 86_400_000;
/** A lead someone picked up in the last week, or one untouched this long, is offered a catch-up (§5.3). */
const HANDED_WITHIN_DAYS = 7;
const QUIET_DAYS = 14;

export type LeadAi = {
  offerCatchUp: boolean;
  pending: { id: string; suggestion: NextStep; from: { activityId: string | null; at: string } } | null;
};

/** `GET /api/v1/leads/:id/ai`: whether to offer a catch-up to this person, and a next step still waiting. */
export async function leadAi(req: FastifyRequest, d: AppDeps, leadId: string): Promise<LeadAi> {
  const lead = await visibleLead(req, leadId);
  if (!(await aiStatus(req, d)).on) return { offerCatchUp: false, pending: null };
  const now = d.clock().getTime();
  const handed = await req.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM lead_assignment_history
        WHERE lead_id = ${lead.id} AND to_user_id = ${req.actor!.userId}
          AND changed_at > ${new Date(now - HANDED_WITHIN_DAYS * DAY).toISOString()}::timestamptz`,
  );
  const quiet = !lead.lastActivityAt || now - lead.lastActivityAt.getTime() >= QUIET_DAYS * DAY;
  const [p] = await req.db
    .select({
      id: schema.aiReads.id,
      result: schema.aiReads.result,
      source: schema.aiReads.sourceActivityId,
      at: schema.aiReads.createdAt,
    })
    .from(schema.aiReads)
    .where(
      and(
        eq(schema.aiReads.leadId, lead.id),
        eq(schema.aiReads.task, "next_step"),
        eq(schema.aiReads.status, "ok"),
        isNull(schema.aiReads.outcome),
      ),
    )
    .orderBy(desc(schema.aiReads.createdAt))
    .limit(1);
  return {
    offerCatchUp: Number(handed.rows[0]?.n ?? 0) > 0 || quiet,
    pending: p
      ? {
          id: p.id,
          suggestion: (p.result as { suggestion: NextStep }).suggestion,
          from: { activityId: p.source, at: p.at.toISOString() },
        }
      : null,
  };
}

/** `POST /api/v1/leads/:id/ai/catch-up` (§5.3): three lines from the lead's own history, on request only. */
export async function catchUp(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string,
): Promise<{ read: { id: string; lines: [string, string, string] } } | AiUnavailable> {
  const lead = await visibleLead(req, leadId);
  const facts = await leadFacts(req, d, lead);
  const r = await runRead(req, d, {
    task: "catch_up",
    leadId: lead.id,
    instructions: instructionsFor("catch_up"),
    input: inputFor("catch_up", facts),
    schema: catchUpOutput,
    maxOutputTokens: 1500,
  });
  return "unavailable" in r ? r : { read: { id: r.id, lines: r.output.lines } };
}
