import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyRequest } from "fastify";
import { can, newId, normalizePhone, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError } from "../../http/errors";
import { loadActor } from "../../rbac/actor";
import { loadMapContext } from "../imports/context";
import { jobServer, withJobRequest } from "../imports/job-request";
import { writeRow } from "../imports/row";
import { isDataError, refusalReason } from "../imports/runner";
import { visibleLead } from "../leads/service";
import { moveStage } from "../leads/write";
import { recordActivity } from "../leads/writer";
import { notify, type NewNotification } from "../notifications/notify";
import { schedule } from "../tasks/engine";
import { eventContext, type ProcessDeps } from "../webhooks/process";
import { openCalendly, type CalendlyConfig } from "./config";

const S = schema.leadSources;
const E = schema.webhookEvents;
type Source = typeof S.$inferSelect;
type Event = typeof E.$inferSelect;
type Problem = { column: number | null; code: string; message: string };

/** What a Calendly post says, as LUME uses it (Calendly's API v2 invitee payload). */
type Invitee = {
  uri: string;
  name: string;
  email: string;
  phone: string;
  hostEmail: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  link: string | null;
  location: string | null;
  rescheduled: boolean;
  reason: string | null;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));

function readInvitee(body: Record<string, unknown>, settings: CalendlyConfig["settings"]): Invitee {
  const p = (body.payload ?? {}) as Record<string, unknown>;
  const ev = (p.scheduled_event ?? {}) as Record<string, unknown>;
  const loc = (ev.location ?? {}) as Record<string, unknown>;
  const members = Array.isArray(ev.event_memberships)
    ? (ev.event_memberships as Record<string, unknown>[])
    : [];
  const qa = Array.isArray(p.questions_and_answers)
    ? (p.questions_and_answers as Record<string, unknown>[])
    : [];
  const fold = (s: string) => s.trim().toLowerCase();
  const asked = settings.phoneQuestion
    ? str(qa.find((x) => fold(str(x.question)) === fold(settings.phoneQuestion!))?.answer)
    : "";
  const name = str(p.name) || [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ");
  const starts = new Date(str(ev.start_time));
  const ends = new Date(str(ev.end_time));
  const join = str(loc.join_url);
  const place = str(loc.location);
  return {
    uri: str(p.uri),
    name: name.trim(),
    email: str(p.email).trim(),
    phone: (str(p.text_reminder_number) || asked).trim(),
    hostEmail: str(members[0]?.user_email).trim(),
    title: str(ev.name).trim() || "Meeting",
    startsAt: starts,
    endsAt: ends < starts ? starts : ends,
    link: join || (/^https?:\/\//.test(place) ? place : null),
    location: place && !/^https?:\/\//.test(place) ? place : null,
    rescheduled: p.rescheduled === true,
    reason: str((p.cancellation as Record<string, unknown> | undefined)?.reason) || null,
  };
}

const finish = (
  req: FastifyRequest,
  eventId: number,
  r: {
    status: "done" | "error";
    result?: "created" | "merged" | null;
    leadId?: string | null;
    problems?: Problem[];
  },
) =>
  req.db
    .update(E)
    .set({
      status: r.status,
      result: r.result ?? null,
      leadId: r.leadId ?? null,
      problems: r.problems ?? [],
      processedAt: new Date(),
    })
    .where(eq(E.id, eventId));

/** "Tue 24 Sep, 2:00 pm", on the business's clock. */
async function when(req: FastifyRequest, at: Date) {
  const [s] = await req.db
    .select({ tz: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: s?.tz ?? "UTC",
  }).format(at);
}

/** The person a Calendly host is in LUME, by email (active people only). */
async function personByEmail(req: FastifyRequest, email: string): Promise<string | null> {
  if (!email) return null;
  const r = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${email} AND status = 'active' LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}

/** A live lead with this email (any case), else this phone: the oldest when two share one. */
async function findLead(req: FastifyRequest, inv: Invitee, country: string | null): Promise<string | null> {
  if (inv.email) {
    const r = await req.db.execute<{ id: string }>(
      sql`SELECT id FROM leads WHERE deleted_at IS NULL AND email = ${inv.email}::citext ORDER BY created_at, id LIMIT 1`,
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  const phone = normalizePhone(inv.phone, country);
  if (phone.e164) {
    const r = await req.db.execute<{ id: string }>(
      sql`SELECT id FROM leads WHERE deleted_at IS NULL AND phone_e164 = ${phone.e164} ORDER BY created_at, id LIMIT 1`,
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

/** Writes as `userId` for one statement's worth of work (a meeting row is its owner's), then back. */
async function asPerson<T>(req: FastifyRequest, userId: string, fn: () => Promise<T>): Promise<T> {
  await req.db.execute(sql`SELECT set_config('lume.user_id', ${userId}, true)`);
  try {
    return await fn();
  } finally {
    await req.db.execute(sql`SELECT set_config('lume.user_id', ${req.actor!.userId}, true)`);
  }
}

/**
 * One Calendly post (5B, spec §3), from the webhook queue. A booking finds or makes its lead through the
 * intake engine, keeps the meeting, moves the lead to its pipeline's booking stage and tells its owner; a
 * cancellation marks the meeting, tells the owner and sets a Reschedule follow-up. Safe to run twice: the
 * event is locked and re-checked, and a meeting already kept says nothing again.
 */
export async function processCalendlyEvent(o: ProcessDeps, ev: Event, src: Source): Promise<void> {
  // A job's server, carrying what a stage's automations need: the booking stage's own rules run on the move
  // (they're decorated only on the signed-in scope, which a job isn't in).
  o = {
    ...o,
    app: Object.assign(Object.create(jobServer(o.app)) as typeof o.app, {
      automationDeps: { pool: o.pool, tasks: o.tasks },
    }),
  };
  const db = drizzle(o.pool, { schema });
  const cfg = openCalendly(o.keyring, src.id, src.configEnc!);
  const actor = src.runAs ? await loadActor(o.pool, src.runAs) : null;
  if (!actor || !can(actor, "leads.import")) {
    await db
      .update(S)
      .set({
        status: "needs_attention",
        attentionCode: "RUN_AS_ACCESS",
        lastError:
          "The person who connected Calendly can no longer add leads. Connect Calendly again as someone who can.",
      })
      .where(eq(S.id, src.id));
    return; // the post stays queued
  }
  const body = JSON.parse(o.keyring.decrypt(ev.payloadEnc!, eventContext(src.id, ev.eventKey))) as Record<
    string,
    unknown
  >;
  const inv = readInvitee(body, cfg.settings);
  const rules = src.rules as Rules;
  const job = (suffix: string) => ({
    app: o.app,
    pool: o.pool,
    actor,
    requestId: `calendly:${ev.id}:${suffix}`,
    allLeads: true,
  });
  const notices: { userId: string; n: NewNotification }[] = [];
  const armed: number[] = [];

  try {
    const ctx =
      body.event === "invitee.created" && cfg.settings.createLeads
        ? await withJobRequest(job("context"), (req) =>
            loadMapContext(req, {
              pipelineId: rules.pipelineId,
              headerCount: 4,
              columnSettings: {} as never,
            }),
          )
        : null;
    await withJobRequest(job("event"), async (req) => {
      // Locked for this transaction: a retry and the queue can't both handle this post.
      const { rows } = await req.db.execute<{ status: string }>(
        sql`SELECT status FROM webhook_events WHERE id = ${ev.id} FOR UPDATE`,
      );
      if (rows[0]?.status !== "queued" && rows[0]?.status !== "error") return;
      if (body.event === "invitee.canceled") return cancelled(req, o, ev.id, inv, cfg, notices, armed);
      if (!inv.uri || Number.isNaN(inv.startsAt.getTime()))
        return void (await finish(req, ev.id, {
          status: "error",
          problems: [
            { column: null, code: "BAD_BOOKING", message: "Calendly's post had no booking LUME could read." },
          ],
        }));

      // The lead: matched or made by the intake engine (new leads switched on), else only matched.
      let leadId: string | null = null;
      let result: "created" | "merged" | null = null;
      const problems: Problem[] = [];
      if (ctx) {
        const r = await writeRow(req, {
          sourceId: src.id,
          rules,
          mapping: src.mapping as Mapping,
          ctx,
          cells: [inv.name, inv.email, inv.phone, inv.hostEmail],
          origin: { sourceId: src.id, calendly: true, event: ev.id },
          automations: { pool: o.pool, tasks: o.tasks },
          nextTurn: async () => 0,
        });
        if (r.result === "created" || r.result === "merged") {
          leadId = r.leadId;
          result = r.result;
        } else problems.push(...r.problems);
      } else leadId = await findLead(req, inv, rules.defaultCountry);

      const lead = leadId ? await visibleLead(req, leadId) : null;
      const hostId = await personByEmail(req, inv.hostEmail);
      const ownerId = hostId ?? lead?.ownerId ?? actor.userId;
      const kept = await asPerson(req, ownerId, async () =>
        req.db.execute<{ id: string; fresh: boolean }>(sql`
          INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, link, location)
          VALUES (${newId()}, ${leadId}, ${ownerId}, 'calendly', ${inv.uri}, 'calendly', ${cut(inv.title, 1000)},
                  ${inv.startsAt}, ${inv.endsAt}, ${cut(inv.link, 2000)}, ${cut(inv.location, 1000)})
          ON CONFLICT (source, owner_id, external_id) DO UPDATE SET updated_at = meetings.updated_at
          RETURNING id, (xmax = 0) AS fresh`),
      );
      const meeting = kept.rows[0]!;
      if (meeting.fresh && lead) {
        await recordActivity(req, lead.id, "meeting_booked", {
          meetingId: meeting.id,
          title: inv.title,
          startsAt: inv.startsAt.toISOString(),
        });
        // To the pipeline's booking stage, unless it's there or past it (won or lost); a refusal is said.
        const [p] = await req.db
          .select({ booking: schema.pipelines.bookingStageId })
          .from(schema.pipelines)
          .where(eq(schema.pipelines.id, lead.pipelineId));
        const [now] = await req.db
          .select({ kind: schema.stages.kind })
          .from(schema.stages)
          .where(eq(schema.stages.id, lead.stageId));
        if (p?.booking && p.booking !== lead.stageId && now?.kind === "open") {
          await req.db.execute(sql`SAVEPOINT lume_booking_move`);
          try {
            await moveStage(req, lead, { stageId: p.booking });
            await req.db.execute(sql`RELEASE SAVEPOINT lume_booking_move`);
          } catch (e) {
            await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_booking_move`);
            if (!(e instanceof HttpError)) throw e;
            problems.push({
              column: null,
              code: "NOT_MOVED",
              message: `LUME kept the meeting but couldn't move the lead to its booking stage (${e.message}).`,
            });
          }
        }
      }
      if (meeting.fresh) {
        const to = lead?.ownerId ?? ownerId;
        notices.push({
          userId: to,
          n: {
            kind: "meeting_booked",
            title: `${lead?.name || inv.name || "Someone"} booked ${inv.title}`,
            body: await when(req, inv.startsAt),
            leadId: lead?.id ?? null,
            data: { meetingId: meeting.id },
          },
        });
      }
      await finish(req, ev.id, { status: "done", result, leadId, problems });
    });
  } catch (e) {
    if (!isDataError(e)) throw e;
    await db
      .update(E)
      .set({
        status: "error",
        problems: [
          {
            column: null,
            code: "ROW_NOT_SAVED",
            message: `LUME couldn't save this booking (${refusalReason(e)}).`,
          },
        ],
        processedAt: new Date(),
      })
      .where(eq(E.id, ev.id));
    return;
  }
  for (const x of notices)
    await notify(o.pool, x.userId, x.n).catch((err: unknown) =>
      o.app.log.error({ err }, "couldn't tell someone about a Calendly booking"),
    );
  if (armed.length && o.tasks) {
    const { rows } = await o.pool.query<{ id: string; fire_at: Date }>(
      "SELECT id, fire_at FROM scheduled_notifications WHERE id = ANY($1::bigint[]) AND status = 'pending'",
      [armed],
    );
    await o.tasks
      .enqueue(rows.map((r) => ({ id: Number(r.id), fireAt: r.fire_at })))
      .catch((err: unknown) =>
        o.app.log.error({ err }, "couldn't queue a Reschedule reminder; the sweeper will"),
      );
  }
}

/**
 * A cancellation: the meeting cancelled (or rescheduled, when Calendly says so: the new booking follows),
 * history, and — not for a reschedule — its owner told and a Reschedule follow-up set.
 */
async function cancelled(
  req: FastifyRequest,
  o: ProcessDeps,
  eventId: number,
  inv: Invitee,
  cfg: CalendlyConfig,
  notices: { userId: string; n: NewNotification }[],
  armed: number[],
) {
  // LUME's own read across people (a meeting is its owner's); the change is then made as that owner.
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
  const found = await req.db.execute<{
    id: string;
    owner_id: string;
    lead_id: string | null;
    status: string;
    title: string;
    outcome_task_id: string | null;
  }>(sql`SELECT id, owner_id, lead_id, status, title, outcome_task_id FROM meetings
          WHERE source = 'calendly' AND external_id = ${inv.uri}`);
  await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
  const m = found.rows[0];
  if (!m || m.status !== "scheduled") return void (await finish(req, eventId, { status: "done" }));
  const status = inv.rescheduled ? "rescheduled" : "cancelled";
  await asPerson(req, m.owner_id, () =>
    req.db.execute(
      sql`UPDATE meetings SET status = ${status}, updated_at = now(), version = version + 1 WHERE id = ${m.id}`,
    ),
  );
  if (m.outcome_task_id) {
    const closed = await req.db.execute<{ id: string }>(
      sql`UPDATE tasks SET status = 'cancelled', cancelled_at = now(), updated_at = now(), version = version + 1
           WHERE id = ${m.outcome_task_id} AND status = 'open' RETURNING id`,
    );
    if (closed.rows[0])
      await req.db.execute(
        sql`UPDATE scheduled_notifications SET status = 'cancelled' WHERE task_id = ${m.outcome_task_id} AND status = 'pending'`,
      );
  }
  const lead = m.lead_id ? await visibleLead(req, m.lead_id) : null;
  if (lead)
    await recordActivity(req, lead.id, inv.rescheduled ? "meeting_rescheduled" : "meeting_cancelled", {
      meetingId: m.id,
      title: m.title,
      reason: cut(inv.reason, 500),
    });
  if (!inv.rescheduled) {
    const to = lead?.ownerId ?? m.owner_id;
    notices.push({
      userId: to,
      n: {
        kind: "meeting_cancelled",
        title: `${lead?.name || inv.name || "Someone"} cancelled ${m.title}`,
        leadId: lead?.id ?? null,
        data: { meetingId: m.id },
      },
    });
    if (cfg.settings.rescheduleFollowUp && lead) {
      const id = newId();
      const [t] = await req.db
        .insert(schema.tasks)
        .values({
          id,
          leadId: lead.id,
          assigneeId: to,
          title: `Reschedule: ${lead.name}`.slice(0, 200),
          dueAt: new Date(),
          remindMinutes: [0],
          seriesId: id,
        })
        .returning();
      armed.push(...(await schedule(req.db, t!, new Date())));
      await req.db.execute(
        sql`UPDATE leads SET next_task_due_at = (SELECT min(due_at) FROM tasks WHERE lead_id = ${lead.id} AND status = 'open') WHERE id = ${lead.id}`,
      );
    }
  }
  await finish(req, eventId, { status: "done", leadId: lead?.id ?? null });
}
