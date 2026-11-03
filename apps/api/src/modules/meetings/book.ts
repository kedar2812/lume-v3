import type { FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { callTimeLabel, newId, slotProblem, type Busy, type CallRules, type SlotProblem } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { calendarClientFor, type GoogleCalendar } from "../calendar/google";
import { GoogleError } from "../sheets/google";
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

export type Booked = {
  id: string;
  label: string;
  leadId: string;
  leadName: string | null;
  tellId: string;
  /** The Meet link LUME made for it (spec 2026-11-03), said under LUME AI's yes; null without one. */
  link: string | null;
  /** Takes the event LUME added back out of Google Calendar, when the yes didn't go (best effort, logged). */
  undo(): void;
};

/** Why LUME couldn't make the Meet link (spec 2026-11-03): a person gets the lead, nothing sent or booked. */
const noMeet = (why: string) =>
  new HttpError(409, "CALL_NO_MEET", `LUME couldn't make a Meet link${why}. Nothing was sent.`);

/** The speaker's Google Calendar, when it may add LUME AI's calls; otherwise why not, in words. */
async function speakerCalendar(
  req: FastifyRequest,
  d: AppDeps,
  ownerId: string,
): Promise<{ google: GoogleCalendar; calendarId: string; name: string }> {
  const [who] = await req.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId));
  const name = who?.name || "the speaker";
  // As the speaker (the run's actor): a person's connection is theirs alone.
  const [c] = await req.db
    .select()
    .from(schema.calendarConnections)
    .where(eq(schema.calendarConnections.userId, ownerId));
  if (!c || !c.addsEvents || !c.callsCalendarId)
    throw noMeet(`: ${name} hasn't let LUME add calls to their Google Calendar`);
  if (c.status !== "active") throw noMeet(`: ${name}'s Google Calendar needs connecting again`);
  const google = calendarClientFor(
    d.googleOAuth,
    d.googleEndpoint,
  )(d.keyring.decrypt(c.grantEnc, `calendar-connection:${c.id}`));
  if (!google) throw noMeet(" just now");
  return { google, calendarId: c.callsCalendarId, name };
}

/**
 * Book the call, as the speaker, after checking it again under a lock on their calendar (two runs saying yes to the
 * same time: the second waits, then sees the first). Throws an HttpError, nothing booked, when the time isn't free.
 */
export async function bookCall(
  req: FastifyRequest,
  d: AppDeps,
  o: {
    ownerId: string;
    leadId: string;
    at: Date;
    rules: CallRules;
    tz: string;
    /** LUME makes the Meet link (spec 2026-11-03): on, and Google Calendar set up and switched on here. */
    meet?: boolean;
  },
): Promise<Booked> {
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume_calls'), hashtext(${o.ownerId}))`);
  const end = new Date(o.at.getTime() + o.rules.minutes * 60_000);
  const busy = await busyFor(req, o.ownerId, o.at, end);
  const problem = slotProblem(o.at, { rules: o.rules, tz: o.tz, now: d.clock(), busy });
  if (problem) throw new HttpError(409, "CALL_NOT_FREE", NOT_FREE[problem]);
  const lead = await visibleLead(req, o.leadId);
  const id = newId();
  const title = `Call with ${lead.name ?? "your lead"}`.slice(0, 1000);
  // The Meet link, made before the meeting is kept: in the speaker's Google Calendar, under the same lock.
  let link: string | null = null;
  let undo = () => {};
  if (o.meet) {
    const cal = await speakerCalendar(req, d, o.ownerId);
    let added: { eventId: string; link: string | null };
    try {
      added = await cal.google.addCall(cal.calendarId, { meetingId: id, title, start: o.at, end, tz: o.tz });
    } catch (e) {
      if (!(e instanceof GoogleError)) throw e;
      req.log.warn({ err: e }, "Google wouldn't add LUME AI's call");
      // They deleted LUME's calendar in Google Calendar, or took LUME's access back: the permission is asked again.
      if (e.kind === "not_found" || e.kind === "access")
        throw new HttpError(
          409,
          "CALL_MEET_GONE",
          `LUME couldn't make a Meet link: LUME can no longer add calls to the LUME calls calendar in ${cal.name}'s Google Calendar. Nothing was sent.`,
        );
      throw noMeet(" just now");
    }
    undo = () =>
      void cal.google
        .removeEvent(cal.calendarId, added.eventId)
        .catch((err: unknown) =>
          req.log.error({ err }, "couldn't remove a call LUME added to Google Calendar"),
        );
    if (!added.link) {
      undo();
      throw noMeet(" just now");
    }
    link = added.link;
  }
  // Anything after the event was added failing: the event comes back out, so Google never keeps a call LUME didn't.
  try {
    await req.db.execute(sql`
    INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, location, link, status)
    VALUES (${id}, ${lead.id}, ${o.ownerId}, 'lume', ${id}, 'lume_ai', ${title}, ${o.at}, ${end},
            ${link ? "Google Meet" : o.rules.how.trim() || null}, ${link}, 'scheduled')`);
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
      link,
      undo,
    };
  } catch (e) {
    undo();
    throw e;
  }
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
