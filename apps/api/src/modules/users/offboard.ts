import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { leadScope } from "@lume/core";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { liveSessionSql, revokeUserSessions } from "../../auth/sessions";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";
import { cancelReminders } from "../tasks/engine";
import { refreshNextDue } from "../tasks/lifecycle";

export type LeadsChoice = { to: "person"; userId: string } | { to: "team"; teamId: string } | { to: "none" };

let failAt: "calendar" | null = null;
/** Tests only: fail at a step, to prove the whole act rolls back (Review Focus 1). */
export function setOffboardFailureForTests(step: "calendar" | null): void {
  failAt = step;
}

const rows = async <R>(req: FastifyRequest, q: ReturnType<typeof sql>) =>
  (await req.db.execute(q)).rows as R[];

type Person = { id: string; name: string; status: string; is_owner: boolean };
async function personOf(req: FastifyRequest, id: string, lock = false): Promise<Person> {
  const [p] = await rows<Person>(
    req,
    sql`SELECT id, name, status, is_owner FROM users WHERE id = ${id} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!p) throw notFound();
  // As Disable does: the owner and yourself are never offboarded, nor previewed for it (6C review).
  if (p.is_owner) throw forbidden("OWNER_PROTECTED", "The owner account can't be changed by anyone else");
  if (id === req.actor!.userId) throw forbidden("SELF", "You can't offboard yourself");
  return p;
}

/** Their sessions someone could use right now: an idle one isn't "signed in" (6C review). */
async function liveSessions(req: FastifyRequest, now: Date, id: string): Promise<number> {
  const [s] = await rows<{ n: number }>(
    req,
    sql`SELECT count(*)::int AS n FROM sessions s
         WHERE s.user_id = ${id} AND ${liveSessionSql("s", now, req.sessionPolicy)}`,
  );
  return s?.n ?? 0;
}

/** LUME's own look across every lead (counts and hand-over), then the admin's own scope back. */
async function everyLead<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  await req.db.execute(sql`SELECT set_config('lume.lead_scope', 'all', true)`);
  try {
    return await fn();
  } finally {
    await req.db.execute(sql`SELECT set_config('lume.lead_scope', ${leadScope(req.actor!) ?? ""}, true)`);
  }
}

/** Active colleagues who can take leads: never the person, a disabled or a paused one. */
const MEMBERS = (teamId: string, personId: string) => sql`
  SELECT u.id, u.name,
         (SELECT count(*)::int FROM leads l JOIN stages st ON st.id = l.stage_id
           WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND st.kind = 'open') AS open_leads
    FROM team_members tm JOIN users u ON u.id = tm.user_id
   WHERE tm.team_id = ${teamId} AND u.status = 'active' AND u.id <> ${personId}
   ORDER BY u.name`;

/**
 * What offboarding someone would do (6C): live sessions, their leads, who could take them (their teams first), their
 * Google Calendar, and their last 30 days. Counts only: never a contact. Live sessions are judged on the app's clock,
 * as signing in judges them.
 */
export async function offboardingPreview(req: FastifyRequest, d: Pick<AppDeps, "clock">, id: string) {
  const p = await personOf(req, id);
  const sessions = await liveSessions(req, d.clock(), id);
  return everyLead(req, async () => {
    const [leads] = await rows<{ total: number; open: number }>(
      req,
      sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE st.kind = 'open')::int AS open
            FROM leads l JOIN stages st ON st.id = l.stage_id WHERE l.owner_id = ${id} AND l.deleted_at IS NULL`,
    );
    const teamRows = await rows<{ id: string; name: string; mine: boolean }>(
      req,
      sql`SELECT t.id, t.name, EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ${id}) AS mine
            FROM teams t WHERE t.deleted_at IS NULL ORDER BY mine DESC, t.name`,
    );
    const teams = [];
    for (const t of teamRows) {
      const members = await rows<{ id: string; name: string; open_leads: number }>(req, MEMBERS(t.id, id));
      if (members.length)
        teams.push({
          id: t.id,
          name: t.name,
          members: members.map((m) => ({ id: m.id, name: m.name, openLeads: m.open_leads })),
        });
    }
    const people = await rows<{ id: string; name: string }>(
      req,
      sql`SELECT id, name FROM users WHERE status = 'active' AND id <> ${id} ORDER BY name`,
    );
    await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
    const [cal] = await rows<{ email: string; upcoming: number }>(
      req,
      sql`SELECT c.google_email AS email,
                 (SELECT count(*)::int FROM meetings m WHERE m.connection_id = c.id AND m.starts_at > now()
                    AND m.status = 'scheduled') AS upcoming
            FROM calendar_connections c WHERE c.user_id = ${id}`,
    );
    await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
    return {
      person: { id: p.id, name: p.name, status: p.status },
      sessions,
      leads: leads ?? { total: 0, open: 0 },
      teams,
      people,
      calendar: cal ?? null,
      last30: await last30(req, id),
    };
  });
}

/** Their last 30 days: different contacts and leads opened, exports, alerts, the busiest day and their usual. */
async function last30(req: FastifyRequest, id: string) {
  const [tz] = await rows<{ tz: string }>(req, sql`SELECT timezone AS tz FROM settings WHERE id = 1`);
  const zone = tz?.tz ?? "UTC";
  const [c] = await rows<{ reveals: number; opened: number; exports: number; alerts: number }>(
    req,
    sql`SELECT
          (SELECT count(DISTINCT entity_id)::int FROM audit_log WHERE actor_user_id = ${id}
              AND action = 'lead.contact.reveal' AND at > now() - interval '30 days') AS reveals,
          (SELECT count(DISTINCT entity_id)::int FROM audit_log WHERE actor_user_id = ${id}
              AND action = 'lead.view' AND at > now() - interval '30 days') AS opened,
          (SELECT count(*)::int FROM lead_exports WHERE user_id = ${id} AND created_at > now() - interval '30 days') AS exports,
          (SELECT count(*)::int FROM security_alerts WHERE user_id = ${id} AND created_at > now() - interval '30 days') AS alerts`,
  );
  const days = await rows<{ day: string; n: number }>(
    req,
    sql`SELECT to_char(at AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day, count(DISTINCT entity_id)::int AS n
          FROM audit_log WHERE actor_user_id = ${id} AND action = 'lead.contact.reveal' AND at > now() - interval '30 days'
         GROUP BY 1 ORDER BY n DESC, day DESC`,
  );
  const total = days.reduce((n, d) => n + d.n, 0);
  return {
    reveals: c?.reveals ?? 0,
    leadsOpened: c?.opened ?? 0,
    exports: c?.exports ?? 0,
    alerts: c?.alerts ?? 0,
    busiest: days[0] ? { day: days[0].day, count: days[0].n } : null,
    usualPerDay: Math.round((total / 30) * 10) / 10,
  };
}

type Outcome = {
  sessions: number;
  leads: {
    to: "person" | "team" | "none";
    moved: number;
    shares?: { id: string; name: string; count: number }[];
  };
  calendar: { meetingsMoved: number; meetingsRemoved: number } | null;
};

/**
 * Offboard someone (spec §4), in one transaction so it's all or nothing: disabled and signed out everywhere; their
 * leads handed on (one person, shared across a team by fewest open leads, or unassigned); their Google Calendar
 * disconnected, its meetings going with their leads; their open alerts settled. One audit entry lists every step.
 */
export async function offboard(
  req: FastifyRequest,
  d: Pick<AppDeps, "clock">,
  id: string,
  choice: LeadsChoice,
): Promise<Outcome> {
  const actor = req.actor!;
  const p = await personOf(req, id, true);
  if (p.status !== "active" && p.status !== "suspended")
    throw conflict("NOT_ACTIVE", `${p.name} is already disabled`);

  let members: { id: string; name: string; open_leads: number }[] = [];
  if (choice.to === "person") {
    const [to] = await rows<{ id: string }>(
      req,
      sql`SELECT id FROM users WHERE id = ${choice.userId} AND status = 'active' AND id <> ${id}`,
    );
    if (!to) throw badRequest("UNKNOWN_USER", "Pick someone active to take the leads");
  } else if (choice.to === "team") {
    const [t] = await rows<{ id: string }>(
      req,
      sql`SELECT id FROM teams WHERE id = ${choice.teamId} AND deleted_at IS NULL`,
    );
    if (!t) throw badRequest("UNKNOWN_TEAM", "That team isn't here");
  }
  const now = d.clock();

  // 1. Signed out everywhere, and kept out. Every session ends; the count is of those that were live.
  const sessions = await liveSessions(req, now, id);
  await req.db.execute(sql`UPDATE users SET status = 'disabled', disabled_at = ${now} WHERE id = ${id}`);
  await revokeUserSessions(req.db, id, "user_offboarded", now);

  // 2. Their leads, handed on.
  const leads = await everyLead(req, async () => {
    const mine = await rows<{ id: string; open: boolean }>(
      req,
      sql`SELECT l.id, st.kind = 'open' AS open FROM leads l JOIN stages st ON st.id = l.stage_id
           WHERE l.owner_id = ${id} AND l.deleted_at IS NULL ORDER BY l.created_at, l.id`,
    );
    if (choice.to !== "team") {
      const to = choice.to === "person" ? choice.userId : null;
      await moveLeads(
        req,
        mine.map((l) => l.id),
        id,
        to,
      );
      return { to: choice.to, moved: mine.length };
    }
    members = await rows(req, MEMBERS(choice.teamId, id));
    if (!members.length) throw badRequest("TEAM_EMPTY", "Nobody active in that team can take the leads");
    // Open leads first, each to whoever has the fewest open leads (C1); then closed ones, each to whoever has been
    // given the fewest closed ones, so old history never tips the open work (6C review).
    const given = new Map<string, string[]>(members.map((m) => [m.id, []]));
    const spread = (leadIds: string[], start: (m: (typeof members)[number]) => number) => {
      const load = new Map(members.map((m) => [m.id, start(m)]));
      for (const lead of leadIds) {
        const next = [...members].sort(
          (a, b) => load.get(a.id)! - load.get(b.id)! || a.name.localeCompare(b.name),
        )[0]!;
        given.get(next.id)!.push(lead);
        load.set(next.id, load.get(next.id)! + 1);
      }
    };
    spread(
      mine.filter((l) => l.open).map((l) => l.id),
      (m) => m.open_leads,
    );
    spread(
      mine.filter((l) => !l.open).map((l) => l.id),
      () => 0,
    );
    for (const [to, ids] of given) await moveLeads(req, ids, id, to);
    return {
      to: "team" as const,
      moved: mine.length,
      shares: members
        .map((m) => ({ id: m.id, name: m.name, count: given.get(m.id)!.length }))
        .filter((s) => s.count > 0),
    };
  });

  // 3. Their Google Calendar: lead meetings go with their leads (C2), the rest and the grant go.
  if (failAt === "calendar") throw new Error("offboarding test failure at the calendar step");
  const disconnected = await disconnectTheirs(req, id);
  const calendar = disconnected && {
    meetingsMoved: disconnected.meetingsMoved,
    meetingsRemoved: disconnected.meetingsRemoved,
  };
  // A removed meeting's Log outcome and reminder follow-ups go with it, as Disconnect does (6C review).
  if (disconnected?.gone.length)
    await everyLead(req, async () => {
      const closed = await rows<{ id: string; lead_id: string }>(
        req,
        sql`UPDATE tasks SET status = 'cancelled', cancelled_at = now(), updated_at = now(), version = version + 1
             WHERE status = 'open'
               AND (id = ANY(${`{${disconnected.outcomeTasks.join(",")}}`}::uuid[])
                    OR meeting_id = ANY(${`{${disconnected.gone.join(",")}}`}::uuid[]))
            RETURNING id, lead_id`,
      );
      for (const t of closed) {
        await cancelReminders(req.db, t.id);
        await refreshNextDue(req, t.lead_id);
      }
    });

  // 4. Their open alerts: settled.
  await req.db.execute(sql`
    UPDATE security_alerts SET status = 'resolved', resolution = 'offboarded', resolved_by = ${actor.userId},
           resolved_at = now()
     WHERE user_id = ${id} AND status = 'open'`);

  await notifyRbac(req, id);
  const outcome: Outcome = { sessions, leads, calendar };
  await audit(req, { action: "user.offboarded", entityType: "user", entityId: id, diff: outcome });
  return outcome;
}

/**
 * Leads to a new owner (or none), each move in the assignment history as an offboarding. Their open follow-ups on
 * those leads go to the new owner too (6C review); left unassigned, they stay on the lead for an admin to hand out.
 */
async function moveLeads(req: FastifyRequest, ids: string[], from: string, to: string | null) {
  if (!ids.length) return;
  const list = `{${ids.join(",")}}`;
  await req.db.execute(sql`
    UPDATE leads SET owner_id = ${to}, version = version + 1, last_activity_at = now()
     WHERE id = ANY(${list}::uuid[])`);
  await req.db.execute(sql`
    INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_by, reason)
    SELECT x, ${from}, ${to}, ${req.actor!.userId}, 'owner_offboarded' FROM unnest(${list}::uuid[]) x`);
  if (to)
    await req.db.execute(sql`
      UPDATE tasks SET assignee_id = ${to}, updated_at = now(), version = version + 1
       WHERE lead_id = ANY(${list}::uuid[]) AND assignee_id = ${from} AND status = 'open'`);
}

/**
 * Their connection, done as them (a calendar connection is its person's own under row-level security), then the
 * admin's own scope back — all inside this one transaction.
 */
async function disconnectTheirs(req: FastifyRequest, id: string) {
  const actor = req.actor!;
  await req.db.execute(
    sql`SELECT set_config('lume.user_id', ${id}, true), set_config('lume.lead_scope', 'all', true)`,
  );
  try {
    const [c] = await rows<{ id: string }>(
      req,
      sql`SELECT id FROM calendar_connections WHERE user_id = ${id}`,
    );
    if (!c) return null;
    // A meeting the lead's new owner already has from their own calendar, linked or not, is kept once, theirs. An
    // unlinked meeting is its owner's alone under row-level security: the sweep's read-only flag lets LUME see it.
    await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', 'on', true)`);
    const dup = await rows<{ id: string; outcome_task_id: string | null }>(
      req,
      sql`DELETE FROM meetings m USING leads l
           WHERE m.connection_id = ${c.id} AND m.lead_id = l.id
             AND EXISTS (SELECT 1 FROM meetings o WHERE o.source = m.source AND o.external_id = m.external_id
                           AND o.owner_id = l.owner_id AND o.id <> m.id)
          RETURNING m.id, m.outcome_task_id`,
    );
    await req.db.execute(sql`SELECT set_config('lume.calendar_sweep', '', true)`);
    const unlinked = await rows<{ id: string; outcome_task_id: string | null }>(
      req,
      sql`DELETE FROM meetings WHERE connection_id = ${c.id} AND lead_id IS NULL RETURNING id, outcome_task_id`,
    );
    const moved = await rows<{ id: string }>(
      req,
      sql`UPDATE meetings m SET owner_id = coalesce(l.owner_id, m.owner_id), connection_id = NULL, updated_at = now(),
                 version = m.version + 1
            FROM leads l WHERE m.lead_id = l.id AND m.connection_id = ${c.id}
          RETURNING m.id`,
    );
    await req.db.execute(sql`DELETE FROM calendar_connections WHERE id = ${c.id}`);
    const gone = [...dup, ...unlinked];
    return {
      meetingsMoved: moved.length,
      meetingsRemoved: gone.length,
      gone: gone.map((m) => m.id),
      outcomeTasks: gone.map((m) => m.outcome_task_id).filter((t): t is string => t !== null),
    };
  } finally {
    await req.db.execute(
      sql`SELECT set_config('lume.user_id', ${actor.userId}, true), set_config('lume.lead_scope', ${leadScope(actor) ?? ""}, true)`,
    );
  }
}
