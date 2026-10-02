import { sql } from "drizzle-orm";
import type pg from "pg";
import { deviceName, type RuleId } from "@lume/core";
import { revokeUserSessions } from "../../auth/sessions";
import type { Db } from "../../db/context";
import { conflict } from "../../http/errors";
import { notify } from "../notifications/notify";
import { lumeAudit } from "./lume-audit";

/**
 * Pause someone (spec §2.5): suspended, every session ended, and sign-in refused until an admin restores
 * them. Their leads stay theirs. Each process's actor cache hears it on `lume_rbac` once this commits.
 * Pausing someone already paused changes nothing.
 */
export async function suspendUser(
  db: Db,
  userId: string,
  now: Date,
  alertId: string | null,
): Promise<{ suspended: boolean; sessionsEnded: string[] }> {
  const { rows: changed } = await db.execute(
    sql`UPDATE users SET status = 'suspended' WHERE id = ${userId} AND status = 'active' RETURNING id`,
  );
  if (!changed.length) return { suspended: false, sessionsEnded: [] };
  // The devices they were signed in on, as the alert's "What LUME did" names them.
  const { rows: live } = await db.execute(sql`
    SELECT user_agent FROM sessions
     WHERE user_id = ${userId} AND revoked_at IS NULL AND stage = 'full' AND expires_at > ${now}
     ORDER BY created_at`);
  const sessionsEnded = live.map((r) => deviceName((r as { user_agent: string | null }).user_agent));
  await revokeUserSessions(db, userId, "suspended", now);
  await db.execute(sql`SELECT pg_notify('lume_rbac', ${userId})`);
  await lumeAudit(db, {
    action: "security.suspended",
    entityType: "user",
    entityId: userId,
    diff: { alertId, sessions: sessionsEnded },
  });
  return { suspended: true, sessionsEnded };
}

/**
 * Restore a paused person (plan ruling R10): active again, counted afresh from now (the burst that paused
 * them can't pause them twice), and every open alert of theirs resolved as restored.
 */
export async function restoreUser(db: Db, userId: string, byUserId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE users SET status = 'active', watch_from = now()
     WHERE id = ${userId} AND status = 'suspended' RETURNING id`);
  if (!rows.length) throw conflict("NOT_SUSPENDED", "This person's access isn't paused");
  await db.execute(sql`
    UPDATE security_alerts
       SET status = 'resolved', resolution = 'restored', resolved_by = ${byUserId}, resolved_at = now()
     WHERE user_id = ${userId} AND status = 'open'`);
  await db.execute(sql`SELECT pg_notify('lume_rbac', ${userId})`);
  await lumeAudit(db, {
    action: "security.restored",
    entityType: "user",
    entityId: userId,
    diff: {},
    actorUserId: byUserId,
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The notice's words: whom and what, never a number in the title (spec §5); the body carries them, for admins. */
export function alertWords(a: {
  name: string;
  rule: RuleId;
  action: "alerted" | "suspended";
  observed: number;
  minutes: number;
}): { title: string; body: string } {
  const title =
    a.action === "suspended"
      ? `LUME paused ${a.name}’s access`
      : a.rule === "reveals"
        ? `${a.name} opened a lot of contacts`
        : a.rule === "leadsOpened"
          ? `${a.name} opened a lot of leads`
          : `${a.name} ran a lot of send queues today`;
  const span = plural(Math.max(1, a.minutes), "minute");
  const body =
    a.rule === "reveals"
      ? `${plural(a.observed, "contact")} opened in ${span}`
      : a.rule === "leadsOpened"
        ? `${plural(a.observed, "different lead")} opened in ${span}`
        : `${plural(a.observed, "send-queue run")} today`;
  return { title, body };
}

/**
 * Tell everyone with `security.manage` (the owner always) about an alert: a notification of its own kind,
 * pushed live. Called once the alert has committed. Recorded as LUME's act, naming who was told.
 */
export async function tellAdmins(pool: pg.Pool, alertId: string): Promise<void> {
  const { rows } = await pool.query<{
    rule: RuleId;
    action: "alerted" | "suspended";
    observed: number;
    minutes: number;
    name: string;
    user_id: string;
  }>(
    `SELECT a.rule, a.action, a.observed, u.name, a.user_id,
            round(extract(epoch FROM a.window_end - a.window_start) / 60)::int AS minutes
       FROM security_alerts a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [alertId],
  );
  const a = rows[0];
  if (!a) return;
  // Never the person the alert is about: no numbers reach the person being watched (spec §5).
  const { rows: admins } = await pool.query<{ id: string; name: string }>(
    `SELECT u.id, u.name FROM users u WHERE u.status = 'active' AND u.id <> $1 AND (u.is_owner OR EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = u.id AND rp.permission_key = 'security.manage'))
      ORDER BY u.is_owner DESC, u.name`,
    [a.user_id],
  );
  const words = alertWords(a);
  const told: string[] = [];
  for (const admin of admins) {
    const id = await notify(pool, admin.id, { kind: "security_alert", ...words, data: { alertId } });
    if (id !== null) told.push(admin.name);
  }
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff)
     VALUES (NULL, 'security.notified', 'security_alert', $1, $2)`,
    [alertId, { names: told }],
  );
}
