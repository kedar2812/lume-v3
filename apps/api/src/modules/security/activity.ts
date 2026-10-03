import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { deviceName } from "@lume/core";
import type { AppDeps } from "../../app";

const rows = async <R>(req: FastifyRequest, q: ReturnType<typeof sql>) =>
  (await req.db.execute(q)).rows as R[];
const DAYS = 14;
const TOP = 6;

/**
 * Security activity (6C, canvas [Main]), for people who may read the audit log: today's tiles, contacts opened
 * per person over 14 days, and who is signed in now. Figures and names only, never a contact. Days are the
 * business's, so a reveal at 23:30 in its time zone counts on that day (Review Focus 5). "Contacts opened" counts
 * different leads per person per day, as the reveals rule does (ruling C5).
 */
export async function securityActivity(req: FastifyRequest, d: Pick<AppDeps, "clock">) {
  const [tzRow] = await rows<{ tz: string }>(req, sql`SELECT timezone AS tz FROM settings WHERE id = 1`);
  const tz = tzRow?.tz ?? "UTC";
  const dayStart = sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
  const weekStart = sql`(date_trunc('week', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

  // Different leads per person per day, for the window: the chart, and today's contacts tile.
  const perDay = await rows<{ user_id: string; day: number; n: number }>(
    req,
    sql`SELECT actor_user_id AS user_id,
               (${DAYS - 1} - ((now() AT TIME ZONE ${tz})::date - (at AT TIME ZONE ${tz})::date))::int AS day,
               count(DISTINCT entity_id)::int AS n
          FROM audit_log
         WHERE action = 'lead.contact.reveal' AND actor_user_id IS NOT NULL
           AND at >= ${dayStart} - make_interval(days => ${DAYS - 1})
         GROUP BY 1, 2`,
  );
  const byPerson = new Map<string, number[]>();
  for (const r of perDay) {
    if (r.day < 0 || r.day >= DAYS) continue;
    const days = byPerson.get(r.user_id) ?? Array<number>(DAYS).fill(0);
    days[r.day] = r.n;
    byPerson.set(r.user_id, days);
  }
  const top = [...byPerson.entries()]
    .map(([id, days]) => ({ id, days, total: days.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || b.days[DAYS - 1]! - a.days[DAYS - 1]!)
    .slice(0, TOP);
  const ids = top.map((t) => t.id);
  const who = ids.length
    ? await rows<{ id: string; name: string; role: string | null; alert: boolean }>(
        req,
        sql`SELECT u.id, u.name,
                   (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
                     WHERE ur.user_id = u.id ORDER BY r.name LIMIT 1) AS role,
                   EXISTS (SELECT 1 FROM security_alerts a WHERE a.user_id = u.id AND a.rule = 'reveals'
                              AND a.created_at >= ${dayStart}) AS alert
              FROM users u WHERE u.id IN (${sql.join(
                ids.map((x) => sql`${x}::uuid`),
                sql`, `,
              )})`,
      )
    : [];
  const named = new Map(who.map((w) => [w.id, w]));
  const today = perDay.filter((r) => r.day === DAYS - 1);

  // Leads opened: today against the median day of the 14 before it.
  const opened = await rows<{ day: number; n: number }>(
    req,
    sql`SELECT ((now() AT TIME ZONE ${tz})::date - (at AT TIME ZONE ${tz})::date)::int AS day,
               count(DISTINCT (actor_user_id, entity_id))::int AS n
          FROM audit_log
         WHERE action = 'lead.view' AND at >= ${dayStart} - make_interval(days => ${DAYS})
         GROUP BY 1`,
  );
  const openedOn = new Map(opened.map((o) => [o.day, o.n]));
  const before = Array.from({ length: DAYS }, (_, i) => openedOn.get(i + 1) ?? 0).sort((a, b) => a - b);
  const usual = Math.round((before[DAYS / 2 - 1]! + before[DAYS / 2]!) / 2);

  const exports = await rows<{ count: number; people: number; name: string | null }>(
    req,
    sql`SELECT count(*)::int AS count, count(DISTINCT e.user_id)::int AS people, min(u.name) AS name
          FROM lead_exports e JOIN users u ON u.id = e.user_id WHERE e.created_at >= ${weekStart}`,
  );
  const failed = await rows<{
    count: number;
    people: number;
    user_id: string | null;
    name: string | null;
    last: string | null;
  }>(
    req,
    sql`SELECT count(*)::int AS count, count(DISTINCT entity_id)::int AS people,
               min(entity_id) AS user_id, min(u.name) AS name, max(a.at)::text AS last
          FROM audit_log a LEFT JOIN users u ON u.id::text = a.entity_id
         WHERE a.action IN ('user.login.failed', 'user.login.locked') AND a.at >= ${dayStart}`,
  );
  const f = failed[0]!;
  const one = f.count > 0 && f.people === 1 && f.user_id !== null && f.name !== null;
  const [after] = one
    ? await rows<{ yes: boolean }>(
        req,
        sql`SELECT EXISTS (SELECT 1 FROM audit_log WHERE action = 'user.login' AND entity_id = ${f.user_id}
                             AND at > ${f.last}::timestamptz) AS yes`,
      )
    : [];

  const sessions = await rows<{
    id: string;
    user_id: string;
    name: string;
    user_agent: string | null;
    created_at: Date | string;
  }>(
    req,
    sql`SELECT s.id, s.user_id, u.name, s.user_agent, s.created_at
          FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.revoked_at IS NULL AND s.stage = 'full' AND s.expires_at > ${d.clock()}
         ORDER BY s.created_at DESC LIMIT 100`,
  );
  const [day] = await rows<{ day: string }>(
    req,
    sql`SELECT to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day`,
  );

  return {
    today: {
      day: day!.day,
      reveals: {
        count: today.reduce((a, r) => a + r.n, 0),
        people: new Set(today.map((r) => r.user_id)).size,
      },
      leadsOpened: { count: openedOn.get(0) ?? 0, usual },
      exports: { count: exports[0]!.count, by: exports[0]!.people === 1 ? exports[0]!.name : null },
      failedSignIns: {
        count: f.count,
        name: one ? f.name : null,
        thenSignedIn: !!after?.yes,
      },
    },
    reveals: top.map((t) => ({
      id: t.id,
      name: named.get(t.id)?.name ?? "Someone",
      role: named.get(t.id)?.role ?? null,
      total: t.total,
      days: t.days,
      alertToday: named.get(t.id)?.alert ?? false,
    })),
    // A session's id is a hash of its token: it never leaves the server.
    sessions: sessions.map((s) => ({
      userId: s.user_id,
      name: s.name,
      device: deviceName(s.user_agent),
      since: new Date(s.created_at).toISOString(),
      you: s.id === req.session?.id,
    })),
  };
}
