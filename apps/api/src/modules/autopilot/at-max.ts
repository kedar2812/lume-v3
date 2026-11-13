import { ACTIVE_STATES } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { tellPeople } from "./ready";

/** What the lead's card says once it has had its 20 counted reads this month (AI leads, 2026-11-12). */
export const AT_MAX_HEADLINE = "LUME AI has done all it can for this lead this month";
export const atMaxReason = (back: string) =>
  `LUME AI gave this lead its 20 replies and suggestions for this month. It's yours from here; LUME AI can help again ${back}.`;

/**
 * A lead's 20 counted reads this month are done (owner's spec 2026-11-12 §4): wherever Autopilot is still working it,
 * it goes to Waiting for you, and its rep is told (the run's starter too), once a month. No more replies, next steps or
 * catch-ups for it until the 1st; its run carries on with the other leads.
 */
export async function handOverAtMax(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string,
  month: string,
  /** "on December 1": when LUME AI can help this lead again, on the business's clock. */
  back: string,
): Promise<void> {
  const pool = d.jobPool ?? d.pool;
  const L = schema.autopilotLeads;
  const working = await req.db
    .select({ runId: L.runId })
    .from(L)
    .where(and(eq(L.leadId, leadId), eq(L.active, true), inArray(L.state, [...ACTIVE_STATES])))
    .for("update");
  if (!working.length) return;
  // Told once a month: a person sending it back to LUME AI, or a second read refused, doesn't tell them again.
  const first = (
    await pool.query<{ r: boolean }>("SELECT lume_ai_lead_capped($1, $2, $3) AS r", [
      leadId,
      month,
      d.clock(),
    ])
  ).rows[0]?.r;
  const headline = AT_MAX_HEADLINE;
  for (const w of working) {
    await req.db
      .update(L)
      .set({
        state: "needs_you",
        reason: atMaxReason(back),
        card: { headline, quote: null },
        draft: null,
        draftPayload: null,
        thought: null,
        nextAt: null,
        updatedAt: d.clock(),
      })
      .where(and(eq(L.runId, w.runId), eq(L.leadId, leadId)));
    await req.db.insert(schema.autopilotEvents).values({ runId: w.runId, leadId, kind: "needs_you" });
    if (first)
      req.afterCommit(
        () =>
          void tellPeople(pool, {
            runId: w.runId,
            leadId,
            kind: "needs_you",
            headline: "LUME AI's 20 replies and suggestions for this month are used",
            toOwner: true,
          }),
      );
  }
}
