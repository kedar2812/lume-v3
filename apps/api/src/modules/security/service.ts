import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  RULES,
  mergeAnomaly,
  showsWatermark,
  type AnomalySettings,
  type RuleId,
  type WatermarkMode,
  type WorkingHours,
} from "@lume/core";
import type { LoginHours, SecuritySettings } from "@lume/db";
import { audit } from "../../audit/audit";
import { normaliseNetworks } from "../../auth/networks";
import { checkLoginRestrictions } from "../../auth/restrictions";
import { conflict, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";
import { workingHoursFrom } from "../settings/follow-ups";
import { restoreUser } from "./suspend";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
/** Raw rows bring timestamps as text or Date, depending on the driver's parsers: one ISO string either way. */
const iso = (d: Date | string) => new Date(d).toISOString();
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const rows = async <R>(req: FastifyRequest, q: ReturnType<typeof sql>) =>
  (await req.db.execute(q)).rows as R[];

// ── The rules and the watermark ────────────────────────────────────────────────────────────────────────────

export type SecurityView = { anomaly: AnomalySettings; watermark: WatermarkMode };

export async function readSecurity(req: FastifyRequest): Promise<SecurityView> {
  const [s] = await rows<{ security: SecuritySettings }>(
    req,
    sql`SELECT security FROM settings WHERE id = 1`,
  );
  return { anomaly: mergeAnomaly(s?.security?.anomaly), watermark: s?.security?.watermark ?? "masked_roles" };
}

/** Saved beside the session settings in `settings.security`, never over them; audited with what changed. */
export async function saveSecurity(req: FastifyRequest, next: SecurityView): Promise<SecurityView> {
  const [s] = await rows<{ security: SecuritySettings }>(
    req,
    sql`SELECT security FROM settings WHERE id = 1 FOR UPDATE`,
  );
  const merged: SecuritySettings = {
    ...(s?.security ?? {}),
    anomaly: next.anomaly,
    watermark: next.watermark,
  };
  await req.db.execute(sql`UPDATE settings SET security = ${JSON.stringify(merged)}::jsonb WHERE id = 1`);
  await audit(req, {
    action: "security.settings_changed",
    entityType: "settings",
    entityId: "security",
    diff: next,
  });
  return readSecurity(req);
}

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────────

type AlertRow = {
  id: string;
  user_id: string;
  name: string;
  rule: RuleId;
  action: "alerted" | "suspended";
  observed: number;
  threshold: number;
  window_start: Date | string;
  window_end: Date | string;
  status: "open" | "resolved";
  resolution: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
};
const alertView = (a: AlertRow) => ({
  id: a.id,
  user: { id: a.user_id, name: a.name, initials: initials(a.name) },
  rule: a.rule,
  action: a.action,
  observed: a.observed,
  threshold: a.threshold,
  windowStart: iso(a.window_start),
  windowEnd: iso(a.window_end),
  status: a.status,
  resolution: a.resolution,
  resolvedBy: a.resolved_by_name,
  resolvedAt: a.resolved_at ? iso(a.resolved_at) : null,
  createdAt: iso(a.created_at),
});
export type AlertView = ReturnType<typeof alertView>;

const ALERTS = sql`
  SELECT a.id, a.user_id, u.name, a.rule, a.action, a.observed, a.threshold, a.window_start, a.window_end,
         a.status, a.resolution, r.name AS resolved_by_name, a.resolved_at, a.created_at
    FROM security_alerts a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.resolved_by`;

/** Open alerts, or everything from the last 30 days (open first), newest first. */
export async function listAlerts(
  req: FastifyRequest,
  status: "open" | "recent",
): Promise<{ alerts: AlertView[] }> {
  const where =
    status === "open"
      ? sql`WHERE a.status = 'open'`
      : sql`WHERE a.status = 'open' OR a.created_at > now() - interval '30 days'`;
  const list = await rows<AlertRow>(
    req,
    sql`${ALERTS} ${where} ORDER BY (a.status = 'open') DESC, a.created_at DESC LIMIT 200`,
  );
  return { alerts: list.map(alertView) };
}

async function oneAlert(req: FastifyRequest, id: string, lock = false): Promise<AlertRow> {
  const [a] = await rows<AlertRow>(
    req,
    sql`${ALERTS} WHERE a.id = ${id} ${lock ? sql`FOR UPDATE OF a` : sql``}`,
  );
  if (!a) throw notFound("NOT_FOUND", "That alert isn't here");
  return a;
}

const ordinal = (n: number) => {
  const s =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10];
  return `${n}${s ?? "th"}`;
};
const listWords = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const LIMIT_WORDS: Record<RuleId, (n: number) => string> = {
  reveals: (n) => `The ${ordinal(n)} contact in an hour: the limit`,
  leadsOpened: (n) => `The ${ordinal(n)} different lead in an hour: the limit`,
  queueRuns: (n) => `The ${ordinal(n)} send-queue run today: the limit`,
};
const RESOLVED_WORDS: Record<string, string> = {
  restored: "Access restored by",
  kept_suspended: "Kept paused by",
  dismissed: "Dismissed by",
  offboarded: "Offboarded by",
};

/**
 * One alert, for its drawer: the burst per minute (with ten minutes before it), what LUME did in words, and the
 * person at a glance — roles, when they joined, how many leads they hold, their usual day for this act, and
 * their last 30 days. Counts name nobody, so they're LUME's own (every lead), whatever the reviewer can see.
 */
export async function alertDetail(req: FastifyRequest, id: string) {
  const a = await oneAlert(req, id);
  const def = RULES[a.rule];
  const [tzRow] = await rows<{ tz: string }>(req, sql`SELECT timezone AS tz FROM settings WHERE id = 1`);
  const tz = tzRow?.tz ?? "UTC";

  // Each counted act at its minute (a lead opened, at the first time it was opened in the burst).
  // The alert's own bounds, read in SQL: a JS date keeps milliseconds, and the act that crossed the line is
  // stamped to the microsecond with the alert's end.
  const from = sql`(SELECT window_start FROM security_alerts WHERE id = ${a.id})`;
  const to = sql`(SELECT window_end FROM security_alerts WHERE id = ${a.id})`;
  const firstSeen = def.distinct
    ? sql`SELECT min(at) AS at FROM audit_log
           WHERE actor_user_id = ${a.user_id} AND action = ${def.audit} AND at >= ${from} AND at <= ${to}
           GROUP BY entity_id`
    : sql`SELECT at FROM audit_log
           WHERE actor_user_id = ${a.user_id} AND action = ${def.audit}
             AND at >= ${from} - interval '10 minutes' AND at <= ${to}`;
  const burst = await rows<{ at: Date | string; n: number }>(
    req,
    sql`SELECT m AS at, (SELECT count(*)::int FROM (${firstSeen}) x WHERE x.at >= m AND x.at < m + interval '1 minute') AS n
          FROM generate_series(date_trunc('minute', ${from} - interval '10 minutes'),
                               date_trunc('minute', ${to}), interval '1 minute') m
         ORDER BY m`,
  );

  const steps = await rows<{ at: Date | string; action: string; diff: Record<string, unknown> }>(
    req,
    sql`SELECT at, action, diff FROM audit_log
         WHERE (entity_type = 'security_alert' AND entity_id = ${a.id} AND action IN ('security.alert', 'security.notified'))
            OR (action = 'security.suspended' AND entity_id = ${a.user_id} AND diff->>'alertId' = ${a.id})
         ORDER BY at, id`,
  );
  const first = firstName(a.name);
  const timeline: { at: string; words: string }[] = [];
  for (const s of steps) {
    const at = iso(s.at);
    if (s.action === "security.alert") timeline.push({ at, words: LIMIT_WORDS[a.rule](a.threshold + 1) });
    else if (s.action === "security.suspended") {
      const devices = (s.diff.sessions as string[] | undefined) ?? [];
      if (devices.length)
        timeline.push({
          at,
          words: `Ended ${first}’s ${devices.length} ${devices.length === 1 ? "session" : "sessions"} (${devices.join(", ")})`,
        });
      timeline.push({ at, words: `Paused sign-in. ${first} sees “Your access is paused”` });
    } else if (s.action === "security.notified") {
      const names = (s.diff.names as string[] | undefined) ?? [];
      if (names.length) timeline.push({ at, words: `Told ${listWords(names)}` });
    }
  }
  if (a.resolution && a.resolved_at)
    timeline.push({
      at: iso(a.resolved_at),
      words: `${RESOLVED_WORDS[a.resolution] ?? "Answered by"} ${a.resolved_by_name ?? "an admin"}`,
    });

  const [who] = await rows<{ created_at: Date | string; roles: string[] | null }>(
    req,
    sql`SELECT u.created_at,
               (SELECT array_agg(r.name::text ORDER BY r.name) FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL WHERE ur.user_id = u.id) AS roles
          FROM users u WHERE u.id = ${a.user_id}`,
  );
  const counted = def.distinct ? sql`count(DISTINCT entity_id)` : sql`count(*)`;
  const days = await rows<{ day: string; n: number }>(
    req,
    sql`SELECT to_char(d, 'YYYY-MM-DD') AS day,
               (SELECT ${counted}::int FROM audit_log
                 WHERE actor_user_id = ${a.user_id} AND action = ${def.audit}
                   AND at >= d AT TIME ZONE ${tz} AND at < (d + interval '1 day') AT TIME ZONE ${tz}) AS n
          FROM generate_series(date_trunc('day', now() AT TIME ZONE ${tz}) - interval '29 days',
                               date_trunc('day', now() AT TIME ZONE ${tz}), interval '1 day') d
         ORDER BY d`,
  );
  const before = days.slice(0, -1);
  const usualPerDay = Math.round((before.reduce((n, d) => n + d.n, 0) / before.length) * 10) / 10;

  return {
    alert: alertView(a),
    burst: burst.map((b) => ({ at: iso(b.at), n: b.n })),
    timeline,
    person: {
      roles: who?.roles ?? [],
      joined: who ? iso(who.created_at) : null,
      leadCount: await leadsHeldBy(req, a.user_id),
      usualPerDay,
    },
    last30: days,
  };
}

/** How many leads someone holds: LUME's own count (every lead), naming none of them. */
async function leadsHeldBy(req: FastifyRequest, userId: string): Promise<number> {
  const c = await req.server.watch.pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows: r } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM leads WHERE owner_id = $1 AND deleted_at IS NULL",
      [userId],
    );
    await c.query("COMMIT");
    return r[0]?.n ?? 0;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Plan ruling R10: restore (every open alert of theirs), keep them paused, or dismiss an alert-only one. */
export async function resolveAlert(
  req: FastifyRequest,
  id: string,
  resolution: "restored" | "kept_suspended" | "dismissed",
): Promise<{ alert: AlertView }> {
  const a = await oneAlert(req, id, true);
  if (a.status === "resolved")
    throw conflict("ALREADY_RESOLVED", `${a.resolved_by_name ?? "Someone"} already answered this alert`);
  const by = req.actor!.userId;
  if (resolution === "restored") await restorePerson(req, a.user_id);
  else {
    if (resolution === "dismissed" && a.action === "suspended")
      throw conflict("PAUSED", "LUME paused them: restore their access, or keep them paused");
    if (resolution === "kept_suspended") {
      const [u] = await rows<{ status: string }>(req, sql`SELECT status FROM users WHERE id = ${a.user_id}`);
      if (u?.status !== "suspended") throw conflict("NOT_SUSPENDED", "Their access isn't paused");
    }
    await req.db.execute(sql`
      UPDATE security_alerts SET status = 'resolved', resolution = ${resolution}, resolved_by = ${by}, resolved_at = now()
       WHERE id = ${id}`);
  }
  await audit(req, {
    action: "security.alert_resolved",
    entityType: "security_alert",
    entityId: id,
    diff: { resolution },
  });
  return { alert: alertView(await oneAlert(req, id)) };
}

/** Restore a paused person (from their alert, or from People), and let them in on the very next request. */
export async function restorePerson(req: FastifyRequest, userId: string): Promise<void> {
  await restoreUser(req.db, userId, req.actor!.userId);
  await notifyRbac(req, userId);
}

// ── Access limits per role ─────────────────────────────────────────────────────────────────────────────────

type RoleAccess = {
  id: string;
  name: string;
  people: number;
  loginHours: LoginHours | null;
  ipAllowlist: string[] | null;
};
const ROLES = sql`
  SELECT r.id, r.name::text AS name, r.login_hours AS "loginHours", r.ip_allowlist::text[] AS "ipAllowlist",
         (SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id
           WHERE ur.role_id = r.id AND u.status <> 'disabled') AS people
    FROM roles r WHERE r.deleted_at IS NULL`;

/** Every role, who holds it, the business's hours and timezone, and the network the editor is on now. */
export async function readAccess(req: FastifyRequest) {
  const roles = await rows<RoleAccess>(req, sql`${ROLES} ORDER BY r.name`);
  const [s] = await rows<{ tz: string; wh: unknown; week_start: number }>(
    req,
    sql`SELECT timezone AS tz, working_hours AS wh, week_start FROM settings WHERE id = 1`,
  );
  return {
    roles,
    workingHours: workingHoursFrom(s?.wh),
    timezone: s?.tz ?? "UTC",
    weekStart: s?.week_start ?? 1,
    yourIp: req.ip,
  };
}

/**
 * Save one role's sign-in hours and networks. Refused when it would refuse the editor right now (plan ruling R6):
 * one of their own roles, their current network and time — unless they're the owner, who is never limited.
 */
export async function saveAccess(
  req: FastifyRequest,
  roleId: string,
  input: { loginHours: LoginHours | null; ipAllowlist: string[] | null },
): Promise<{ role: RoleAccess }> {
  const [role] = await rows<RoleAccess>(req, sql`${ROLES} AND r.id = ${roleId} FOR UPDATE OF r`);
  if (!role) throw notFound("NOT_FOUND", "That role isn't here");
  const ipAllowlist = await normaliseNetworks(req.db, input.ipAllowlist);
  const loginHours = input.loginHours;
  const actor = req.actor!;
  if (!actor.isOwner && actor.roleIds.includes(roleId)) {
    const [s] = await rows<{ tz: string; wh: unknown }>(
      req,
      sql`SELECT timezone AS tz, working_hours AS wh FROM settings WHERE id = 1`,
    );
    const after = actor.roleIds.map((id, i) =>
      id === roleId ? { loginHours, ipAllowlist } : actor.restrictions[i]!,
    );
    const verdict = checkLoginRestrictions({
      roles: after,
      ip: req.ip,
      now: req.server.watch.clock(),
      timezone: s?.tz ?? "UTC",
      workingHours: workingHoursFrom(s?.wh) satisfies WorkingHours,
    });
    if (verdict !== "ok")
      throw conflict(
        "WOULD_LOCK_YOU_OUT",
        verdict === "ip"
          ? `Saving this would sign you out: you're on ${req.ip}. Add this network first.`
          : "Saving this would sign you out: it's outside these hours for you right now.",
      );
  }
  await req.db.execute(sql`
    UPDATE roles SET login_hours = ${loginHours ? JSON.stringify(loginHours) : null}::jsonb,
                     ip_allowlist = ${ipAllowlist ? `{${ipAllowlist.join(",")}}` : null}::cidr[],
                     updated_at = now()
     WHERE id = ${roleId}`);
  await notifyRbac(req);
  await audit(req, {
    action: "security.access_changed",
    entityType: "role",
    entityId: roleId,
    diff: { loginHours, ipAllowlist },
  });
  const [saved] = await rows<RoleAccess>(req, sql`${ROLES} AND r.id = ${roleId}`);
  return { role: saved! };
}

// ── The watermark, as each person signs in ─────────────────────────────────────────────────────────────────

/** Whether lead screens carry this person's watermark (spec §2.6), and today's date on the business's clock. */
export async function watermarkFor(req: FastifyRequest): Promise<{ watermark: boolean; today: string }> {
  const [s] = await rows<{ security: SecuritySettings; today: string }>(
    req,
    sql`SELECT security, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today FROM settings WHERE id = 1`,
  );
  return {
    watermark: showsWatermark(s?.security?.watermark, req.actor!),
    today: s?.today ?? new Date().toISOString().slice(0, 10),
  };
}
