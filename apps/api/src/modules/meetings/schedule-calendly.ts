import type { FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { callTimeLabel, moduleIncluded, newId } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { badRequest, HttpError } from "../../http/errors";
import { bookingPlan, type BookingPlan } from "../calendly/booking";
import { CalendlyError, createCalendly, type CalendlyLink } from "../calendly/client";
import { leadLink, openCalendly, type CalendlyConfig } from "../calendly/config";
import { liveCalendly } from "../calendly/service";
import { visibleLead } from "../leads/service";
import { recordActivity } from "../leads/writer";
import { messageRoute } from "../whatsapp/send";
import { tellScheduled, toBookingStage } from "./book";
import { meetingById, type MeetingView } from "./service";

/**
 * Schedule a meeting on Calendly (owner 2026-11-27: "allow lume to schedule calls in calendly"): a person who sees the
 * Calendar (the routes' calendar.view; Calendly needs no calendar of their own) books a lead
 * on LUME's booking link, at one of the link's own free times. Calendly books it with its Scheduling API and sends the
 * lead its invite and reminders; the meeting is on the lead at once, and Calendly's own post about it later only
 * brings its link and place.
 */

const DAY = 24 * 3_600_000;
/** How far ahead the free times are offered. */
const AHEAD_DAYS = 14;

export type CalendlyReady =
  /** `link` is null when only LUME's own settings were read (no lead yet: Calendly isn't asked). */
  | { ready: true; link: { name: string; duration: number } | null }
  | {
      ready: false;
      why: "off" | "no_link" | "link_gone" | "not_bookable" | "no_email" | "no_phone";
      message: string;
    };

type Ctx = { cfg: CalendlyConfig; link: CalendlyLink; plan: Extract<BookingPlan, { ok: true }> };
const client = (d: AppDeps, token: string) =>
  createCalendly({
    token,
    ...(d.calendlyEndpoint ? { endpoint: d.calendlyEndpoint } : {}),
    ...(d.calendlyWait ? { sleep: d.calendlyWait } : {}),
  });
const unreachable = () =>
  new HttpError(
    503,
    "CALENDLY_UNAVAILABLE",
    "LUME couldn't reach Calendly. Nothing was booked. Try again in a minute.",
  );

/** The business's Calendly, its booking link, and what a booking on it needs; or why it can't be booked, in words. */
async function context(req: FastifyRequest, d: AppDeps, quick = false): Promise<Ctx | CalendlyReady> {
  const s = await liveCalendly(req);
  const inPlan = moduleIncluded(req.server.licence.view().plan, "calendly");
  if (!s || !inPlan || s.status === "paused")
    return { ready: false, why: "off", message: "Calendly isn't connected to LUME." };
  const cfg = openCalendly(d.keyring, s.id, s.configEnc!);
  const book = cfg.settings.bookWith;
  if (!book || !leadLink(cfg.settings, book))
    return {
      ready: false,
      why: "no_link",
      message:
        "No booking link is chosen for LUME yet. An admin can choose one in Settings → Integrations → Calendly.",
    };
  // Only whether it's set up (review 2026-11-28: every drawer asks, so Calendly isn't, until a lead is chosen).
  if (quick) return { ready: true, link: null };
  let links: CalendlyLink[];
  try {
    links = await client(d, cfg.token).links({
      scope: cfg.scope,
      organization: cfg.organization,
      user: cfg.user,
    });
  } catch (e) {
    if (e instanceof CalendlyError && e.kind !== "unavailable")
      return {
        ready: false,
        why: "off",
        message: "Calendly needs connecting again in Settings → Integrations.",
      };
    throw unreachable();
  }
  const link = links.find((l) => l.uri === book);
  if (!link)
    return {
      ready: false,
      why: "link_gone",
      message:
        "LUME's booking link is no longer active in Calendly. An admin can choose another in Settings.",
    };
  const plan = bookingPlan(link, cfg.settings);
  if (!plan.ok)
    return { ready: false, why: "not_bookable", message: `LUME can't book on ${link.name}: ${plan.why}` };
  return { cfg, link, plan };
}

/** What the lead must have for this link: an email always (Calendly's), a phone when Calendly calls or asks it. */
function leadProblem(
  lead: { email: string | null; phoneE164: string | null; name: string | null },
  plan: Ctx["plan"],
) {
  const who = (lead.name ?? "").trim().split(/\s+/)[0] || "This lead";
  if (!lead.email)
    return {
      ready: false as const,
      why: "no_email" as const,
      message: `${who} has no email, and Calendly needs one to book. Add it to the lead, or book on Google Calendar.`,
    };
  if (plan.needsPhone && !lead.phoneE164)
    return {
      ready: false as const,
      why: "no_phone" as const,
      message: `${who} has no phone, and this Calendly link needs one. Add it to the lead first.`,
    };
  return null;
}

/** `GET /api/v1/meetings/schedule/calendly?leadId=`: ready or why not, and the link's free times for two weeks. */
export async function calendlyOptions(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string | null,
): Promise<{ ready: CalendlyReady; times: string[]; send?: SendInstead }> {
  const c = await context(req, d, !leadId);
  if ("ready" in c) return { ready: c, times: [] };
  const lead = await visibleLead(req, leadId!);
  const p = leadProblem(lead, c.plan);
  // No email, so Calendly can't book them (pending list 2026-11-28): the link's own page to send instead, for them to
  // pick a time themselves, with a message ready and whether WhatsApp can take it.
  if (p?.why === "no_email") {
    const first = (lead.name ?? "").trim().split(/\s+/)[0];
    return {
      ready: p,
      times: [],
      send: {
        url: c.link.schedulingUrl,
        message: `Hi${first ? ` ${first}` : ""}, here's where to pick a time for our call: ${c.link.schedulingUrl}`,
        whatsapp: await messageRoute(req, d, lead.id),
      },
    };
  }
  if (p) return { ready: p, times: [] };
  const now = d.clock();
  let times: Date[];
  try {
    times = await client(d, c.cfg.token).freeTimes(
      c.link.uri,
      new Date(now.getTime() + 60_000),
      new Date(now.getTime() + AHEAD_DAYS * DAY),
    );
  } catch {
    throw unreachable();
  }
  return {
    ready: { ready: true, link: { name: c.link.name, duration: c.link.duration } },
    times: times.map((t) => t.toISOString()),
  };
}

export type CalendlyScheduled = { meeting: MeetingView; label: string };
/** The booking link to send a lead Calendly can't book, with a message ready and how WhatsApp can take it. */
type SendInstead = { url: string; message: string; whatsapp: Awaited<ReturnType<typeof messageRoute>> };

/** `POST /api/v1/meetings/schedule/calendly`: books the lead on LUME's booking link at one of its free times. */
export async function scheduleOnCalendly(
  req: FastifyRequest,
  d: AppDeps,
  b: { leadId: string; startsAt: string },
): Promise<CalendlyScheduled> {
  const lead = await visibleLead(req, b.leadId);
  const start = new Date(b.startsAt);
  if (Number.isNaN(start.getTime()))
    throw badRequest("BAD_MEETING", "Choose one of the times Calendly offers.");
  if (start.getTime() < d.clock().getTime()) throw badRequest("MEETING_PAST", "Choose a time from now on.");
  const c = await context(req, d);
  if ("ready" in c)
    throw new HttpError(409, "CALENDLY_NOT_READY", c.ready ? "Calendly isn't ready." : c.message);
  const p = leadProblem(lead, c.plan);
  if (p) throw new HttpError(409, "CALENDLY_NOT_READY", p.message);
  const [tzRow] = await req.db.select({ tz: schema.settings.timezone }).from(schema.settings);
  const tz = tzRow?.tz ?? "UTC";
  const me = req.actor!.userId;
  // One booking of a lead at a time (pending list 2026-11-28): a second press, or a colleague at the same moment, waits
  // here, then finds the first one's meeting rather than booking the lead twice.
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('calendly_lead_booking'), hashtext(${lead.id}))`,
  );
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
  const twice = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM meetings WHERE lead_id = ${lead.id} AND source = 'calendly' AND status = 'scheduled'
          AND starts_at = ${start} LIMIT 1`,
  );
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
  if (twice.rows[0])
    return { meeting: await meetingById(req, twice.rows[0].id), label: callTimeLabel(start, tz) };
  const cal = client(d, c.cfg.token);
  const location = c.plan.location
    ? {
        kind: c.plan.location.kind,
        ...(c.plan.location.fixed
          ? { location: c.plan.location.fixed }
          : c.plan.location.kind === "outbound_call"
            ? { location: lead.phoneE164! }
            : {}),
      }
    : undefined;
  let booked: { uri: string; event: string };
  try {
    booked = await cal.book({
      link: c.link.uri,
      at: start,
      name: lead.name?.trim() || lead.email!,
      email: lead.email!,
      timezone: tz,
      ...(location ? { location } : {}),
      ...(c.plan.phoneQuestion
        ? { answers: [{ question: c.plan.phoneQuestion, answer: lead.phoneE164!, position: 0 }] }
        : {}),
    });
  } catch (e) {
    req.log.warn({ err: e }, "Calendly wouldn't book a meeting");
    if (
      e instanceof CalendlyError &&
      e.kind === "bad_request" &&
      /no longer available|not available/i.test(e.said)
    )
      throw new HttpError(
        409,
        "CALENDLY_TIME_TAKEN",
        "That time isn't free in Calendly any more. Nothing was booked. Choose another.",
      );
    if (e instanceof CalendlyError && e.kind !== "unavailable")
      throw new HttpError(409, "CALENDLY_REFUSED", "Calendly didn't take the booking. Nothing was booked.");
    // No answer: Calendly may have booked it all the same (its post then brings it in), so LUME never says it didn't.
    throw new HttpError(
      503,
      "CALENDLY_UNAVAILABLE",
      "LUME didn't hear back from Calendly. Check Calendly before trying again: the booking may have gone through.",
    );
  }
  // One booking at a time (the lock Calendly's post takes too): its post, if it came first, already holds the meeting.
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('calendly_booking'), hashtext(${booked.uri}))`,
  );
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
  const first = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM meetings WHERE source = 'calendly' AND external_id = ${booked.uri} LIMIT 1`,
  );
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
  if (first.rows[0])
    return { meeting: await meetingById(req, first.rows[0].id), label: callTimeLabel(start, tz) };
  const id = newId();
  const end = new Date(start.getTime() + c.link.duration * 60_000);
  try {
    await req.db.execute(sql`
      INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, location, link, status)
      VALUES (${id}, ${lead.id}, ${me}, 'calendly', ${booked.uri}, 'lume', ${c.link.name.slice(0, 1000)}, ${start}, ${end},
              ${location?.location ?? null}, null, 'scheduled')`);
    await recordActivity(req, lead.id, "meeting_booked", {
      meetingId: id,
      title: c.link.name,
      startsAt: start.toISOString(),
      byAi: false,
    });
    await toBookingStage(req, lead);
    await tellScheduled(req, d, {
      leadId: lead.id,
      leadName: lead.name,
      ownerId: lead.ownerId,
      meetingId: id,
      label: callTimeLabel(start, tz),
    });
    await audit(req, {
      action: "meeting.scheduled",
      entityType: "lead",
      entityId: lead.id,
      diff: { meetingId: id, via: "calendly" },
    });
    return { meeting: await meetingById(req, id), label: callTimeLabel(start, tz) };
  } catch (e) {
    // Calendly has it and LUME couldn't keep it: it's cancelled there, so the lead isn't sent an invite for nothing.
    void cal
      .cancel(booked.event, "It couldn't be saved in LUME.")
      .catch((err: unknown) => req.log.error({ err }, "couldn't cancel a Calendly booking LUME didn't keep"));
    throw e;
  }
}
