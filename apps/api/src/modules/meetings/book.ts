import type { FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { callTimeLabel, newId, slotProblem, type Busy, type CallRules, type SlotProblem } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { visibleLead } from "../leads/service";
import { moveStage } from "../leads/write";
import { recordActivity } from "../leads/writer";
import { notify } from "../notifications/notify";
import { remindForStage } from "../tasks/automations";

/**
 * A call LUME AI says yes to (spec 2026-11-02 LUME AI books calls): a meeting on the lead, on the speaker's calendar in
 * LUME, booked in the same transaction as the reply that says yes, so a "Done, 5 pm" never goes for a time that's gone.
 */

/**
 * The speaker's meetings that aren't cancelled, from any source (LUME AI's, Calendly's, their Google Calendar's), between
 * two instants: whoever's lead they're with, so read across row-level security (the calendar sweep's read-only view).
 */
export async function busyFor(req: FastifyRequest, ownerId: string, from: Date, to: Date): Promise<Busy[]> {
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
  try {
    const r = await req.db.execute<{ starts_at: Date | string; ends_at: Date | string }>(
      sql`SELECT starts_at, ends_at FROM meetings
          WHERE owner_id = ${ownerId} AND status <> 'cancelled' AND starts_at < ${to} AND ends_at > ${from}`,
    );
    return r.rows.map((x) => ({ start: new Date(x.starts_at), end: new Date(x.ends_at) }));
  } finally {
    await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
  }
}

const NOT_FREE: Record<SlotProblem, string> = {
  outside: "That time is outside the ones LUME AI may say yes to now. Nothing was sent.",
  soon: "That time is too soon now. Nothing was sent.",
  far: "That time is further ahead than LUME AI may book. Nothing was sent.",
  taken: "LUME AI wanted to say yes to a call at a time you already have a meeting.",
};

export type Booked = { id: string; label: string; leadId: string; leadName: string | null; tellId: string };

/**
 * Book the call, as the speaker, after checking it again under a lock on their calendar (two runs saying yes to the
 * same time: the second waits, then sees the first). Throws an HttpError, nothing booked, when the time isn't free.
 */
export async function bookCall(
  req: FastifyRequest,
  d: AppDeps,
  o: { ownerId: string; leadId: string; at: Date; rules: CallRules; tz: string },
): Promise<Booked> {
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume_calls'), hashtext(${o.ownerId}))`);
  const end = new Date(o.at.getTime() + o.rules.minutes * 60_000);
  const busy = await busyFor(req, o.ownerId, o.at, end);
  const problem = slotProblem(o.at, { rules: o.rules, tz: o.tz, now: d.clock(), busy });
  if (problem) throw new HttpError(409, "CALL_NOT_FREE", NOT_FREE[problem]);
  const lead = await visibleLead(req, o.leadId);
  const id = newId();
  const title = `Call with ${lead.name ?? "your lead"}`.slice(0, 1000);
  await req.db.execute(sql`
    INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, location, status)
    VALUES (${id}, ${lead.id}, ${o.ownerId}, 'lume', ${id}, 'lume_ai', ${title}, ${o.at}, ${end},
            ${o.rules.how.trim() || null}, 'scheduled')`);
  await recordActivity(req, lead.id, "meeting_booked", {
    meetingId: id,
    title,
    startsAt: o.at.toISOString(),
    byAi: true,
  });
  // As a booking from Calendly does: to the pipeline's booking stage, unless it's there or the lead is closed.
  const [p] = await req.db
    .select({ booking: schema.pipelines.bookingStageId })
    .from(schema.pipelines)
    .where(eq(schema.pipelines.id, lead.pipelineId));
  const [now] = await req.db
    .select({ kind: schema.stages.kind })
    .from(schema.stages)
    .where(eq(schema.stages.id, lead.stageId));
  let moved = false;
  if (p?.booking && p.booking !== lead.stageId && now?.kind === "open") {
    await req.db.execute(sql`SAVEPOINT lume_call_move`);
    try {
      await moveStage(req, lead, { stageId: p.booking }, { via: "ai_autopilot" });
      await req.db.execute(sql`RELEASE SAVEPOINT lume_call_move`);
      moved = true;
    } catch (e) {
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_call_move`);
      if (!(e instanceof HttpError)) throw e;
      req.log.warn({ err: e }, "LUME AI booked a call but couldn't move the lead to its booking stage");
    }
  }
  // No move (already there): the stage's meeting reminders run now there's a meeting.
  if (!moved && now?.kind === "open") await remindForStage(req, lead);
  return {
    id,
    label: callTimeLabel(o.at, o.tz),
    leadId: lead.id,
    leadName: lead.name,
    tellId: lead.ownerId ?? o.ownerId,
  };
}

/** Tell the lead's owner, once the booking and its reply are both kept (never for one rolled back). */
export function tellBooked(req: FastifyRequest, d: AppDeps, b: Booked) {
  const pool = d.jobPool ?? d.pool;
  req.afterCommit(
    () =>
      void notify(pool, b.tellId, {
        kind: "meeting_booked",
        title: `LUME AI booked a call with ${b.leadName || "a lead"}`,
        body: b.label,
        leadId: b.leadId,
        data: { meetingId: b.id },
      }).catch((err: unknown) => req.log.error({ err }, "couldn't tell someone about a call LUME AI booked")),
  );
}
