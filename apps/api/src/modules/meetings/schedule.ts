import type { FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { callTimeLabel, can, meetingMessage, moduleIncluded, newId, type ScheduleMeeting } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { badRequest, HttpError } from "../../http/errors";
import { calendarOn } from "../calendar/service";
import { GoogleError } from "../sheets/google";
import { visibleLead } from "../leads/service";
import { recordActivity } from "../leads/writer";
import { messageRoute } from "../whatsapp/send";
import { speakerCalendar, toBookingStage } from "./book";
import { meetingById, type MeetingView } from "./service";

/**
 * Schedule a meeting (owner, 2026-11-13): a person books a call with a lead from its card or the Calendar, on their own
 * LUME calls calendar with a new Meet link, kept on the lead as LUME AI's calls are; then the link may go on WhatsApp.
 */

export type ScheduleReady =
  { ready: true } | { ready: false; why: "off" | "connect" | "permission" | "reconnect"; message: string };

const NOT_READY: Record<Exclude<ScheduleReady, { ready: true }>["why"], string> = {
  off: "Google Calendar is off in LUME. An admin can switch it on in Settings → Integrations.",
  connect: "Connect your Google Calendar to schedule meetings with a Meet link.",
  permission: "Let LUME add meetings to your Google Calendar, so it can make the Meet link.",
  reconnect: "Connect your Google Calendar again to schedule meetings with a Meet link.",
};
const notReady = (why: keyof typeof NOT_READY): ScheduleReady => ({
  ready: false,
  why,
  message: NOT_READY[why],
});

/** Whether this person can schedule now: Google Calendar on here, theirs connected, active, and adding events. */
export async function scheduleReady(req: FastifyRequest, d: AppDeps): Promise<ScheduleReady> {
  const inPlan = moduleIncluded(req.server.licence.view().plan, "googleCalendar");
  if (!d.googleOAuth || !inPlan || !(await calendarOn(req))) return notReady("off");
  const [c] = await req.db
    .select({
      status: schema.calendarConnections.status,
      addsEvents: schema.calendarConnections.addsEvents,
      callsCalendarId: schema.calendarConnections.callsCalendarId,
    })
    .from(schema.calendarConnections)
    .where(eq(schema.calendarConnections.userId, req.actor!.userId));
  if (!c) return notReady("connect");
  if (c.status !== "active") return notReady("reconnect");
  if (!c.addsEvents || !c.callsCalendarId) return notReady("permission");
  return { ready: true };
}

/** The business's clock: the meeting's time is said on it, in the event and in the WhatsApp message. */
async function businessTz(req: FastifyRequest): Promise<string> {
  const [s] = await req.db.select({ tz: schema.settings.timezone }).from(schema.settings);
  return s?.tz ?? "UTC";
}

export type Scheduled = {
  meeting: MeetingView;
  link: string;
  /** "November 20, Friday at 5 pm", on the business's clock. */
  label: string;
  /** What goes to the lead on WhatsApp, ready to edit. */
  message: string;
  whatsapp: { send: boolean; why: string | null; open: boolean };
};

/**
 * `POST /api/v1/meetings/schedule`: checked in words (ready, a lead they may see, a time from now on), the event added to
 * their LUME calls calendar with a Meet link, then kept: the meeting, a line in the lead's history, the move to the
 * booking stage. Anything after Google failing takes the event back out, so Google never keeps one LUME didn't.
 */
export async function scheduleMeeting(
  req: FastifyRequest,
  d: AppDeps,
  b: ScheduleMeeting,
): Promise<Scheduled> {
  // A lead they can't see is missing, whatever else is true.
  const lead = await visibleLead(req, b.leadId);
  const ready = await scheduleReady(req, d);
  if (!ready.ready) throw new HttpError(409, "MEETING_NOT_READY", ready.message);
  const start = new Date(b.startsAt);
  // A minute's grace for a time picked as the clock turns; anything earlier is a mistake.
  if (start.getTime() < d.clock().getTime() - 60_000)
    throw badRequest("MEETING_PAST", "Choose a time from now on.");
  const end = new Date(start.getTime() + b.minutes * 60_000);
  const me = req.actor!.userId;
  const tz = await businessTz(req);
  const id = newId();
  // One booking at a time per person, as LUME AI's are: the event and the meeting go together.
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume_calls'), hashtext(${me}))`);
  const cal = await speakerCalendar(req, d, me).catch((e: unknown) => {
    if (e instanceof HttpError) throw new HttpError(409, "MEETING_NOT_READY", NOT_READY.permission);
    throw e;
  });
  let added: { eventId: string; link: string | null };
  try {
    added = await cal.google.addCall(cal.calendarId, {
      meetingId: id,
      title: b.title,
      start,
      end,
      tz,
      description: b.notes || "Scheduled in LUME.",
    });
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    req.log.warn({ err: e }, "Google wouldn't add a scheduled meeting");
    if (e.kind === "not_found" || e.kind === "access")
      throw new HttpError(
        409,
        "MEETING_NOT_READY",
        "LUME can't add meetings to your LUME calls calendar any more. Connect your Google Calendar again.",
      );
    throw new HttpError(
      503,
      "GOOGLE_UNAVAILABLE",
      "Google Calendar didn't answer just now. Nothing was scheduled. Try again.",
    );
  }
  const undo = () =>
    void cal.google
      .removeEvent(cal.calendarId, added.eventId)
      .catch((err: unknown) =>
        req.log.error({ err }, "couldn't remove a meeting LUME added to Google Calendar"),
      );
  if (!added.link) {
    undo();
    throw new HttpError(
      503,
      "GOOGLE_UNAVAILABLE",
      "Google didn't make a Meet link just now. Nothing was scheduled. Try again.",
    );
  }
  try {
    await req.db.execute(sql`
      INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, location, link, status)
      VALUES (${id}, ${lead.id}, ${me}, 'lume', ${id}, 'lume', ${b.title}, ${start}, ${end}, 'Google Meet', ${added.link}, 'scheduled')`);
    await recordActivity(req, lead.id, "meeting_booked", {
      meetingId: id,
      title: b.title,
      startsAt: start.toISOString(),
      byAi: false,
    });
    await toBookingStage(req, lead);
    await audit(req, {
      action: "meeting.scheduled",
      entityType: "lead",
      entityId: lead.id,
      diff: { meetingId: id },
    });
    // Everything the answer needs is read here too: nothing after this can fail and leave Google's event behind.
    return {
      meeting: await meetingById(req, id),
      link: added.link,
      label: callTimeLabel(start, tz),
      message: meetingMessage({ name: lead.name, at: start, tz, link: added.link }),
      whatsapp: await messageRoute(req, d, lead.id),
    };
  } catch (e) {
    undo();
    throw e;
  }
}

/** Who may schedule: a person who may connect their own calendar and see lead meetings. */
export const maySchedule = (req: FastifyRequest) =>
  !!req.actor &&
  (req.actor.isOwner || (can(req.actor, "calendar.connect") && can(req.actor, "calendar.view")));
