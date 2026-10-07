import type pg from "pg";
import { leadScope, scopeOf, type Actor, plural } from "@lume/core";
import { loadActor } from "../../rbac/actor";
import { notify } from "../notifications/notify";
import type { EngineDeps } from "./engine";

const H = 3_600_000;

/** Whether a manager may act on this person's follow-ups: `all`, or `team` with them in one of their teams. */
const manages = (m: Actor, assigneeId: string) => {
  const s = scopeOf(m, "tasks.manage_others");
  return s === "all" || (s === "team" && m.teamMemberIds.includes(assigneeId));
};
/** Whether they could see the lead (lume_can_see_owner, for another person). */
const sees = (m: Actor, ownerId: string | null) => {
  const s = leadScope(m);
  return (
    s === "all" ||
    (!!ownerId && (ownerId === m.userId || (s === "team" && m.teamMemberIds.includes(ownerId))))
  );
};

type Row = {
  id: string;
  assignee_id: string;
  assignee: string;
  lead_id: string;
  lead: string;
  owner_id: string | null;
  due_at: Date;
};

/**
 * A follow-up left overdue past Settings → Follow-ups' hours reaches the people who manage its assignee, once
 * (3B Task 3; report §10.4.6). Managers are the owner, and people with Manage others' follow-ups at `all`,
 * or at `team` over the assignee — each only if they can see the lead, and never the assignee themselves.
 * The follow-up is marked first, in its own transaction, so two runs never tell anyone twice.
 */
export async function escalate(o: EngineDeps, now: Date = new Date()): Promise<number> {
  const client = await o.pool.connect();
  let due: Row[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lume.lead_scope', 'all', true)"); // LUME's own read; names nobody
    const { rows } = await client.query<Row>(
      `SELECT t.id, t.assignee_id, u.name AS assignee, t.lead_id, l.name AS lead, l.owner_id, t.due_at
         FROM tasks t JOIN leads l ON l.id = t.lead_id JOIN users u ON u.id = t.assignee_id, settings s
        WHERE s.id = 1 AND (s.follow_ups -> 'escalation' ->> 'enabled')::boolean
          AND t.status = 'open' AND t.escalated_at IS NULL AND l.deleted_at IS NULL
          AND t.due_at < $1::timestamptz - make_interval(hours => (s.follow_ups -> 'escalation' ->> 'hours')::int)
        ORDER BY t.due_at LIMIT 200
        FOR UPDATE OF t SKIP LOCKED`,
      [now],
    );
    due = rows;
    if (due.length)
      await client.query("UPDATE tasks SET escalated_at = $2 WHERE id = ANY($1::uuid[])", [
        due.map((r) => r.id),
        now,
      ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  if (!due.length) return 0;

  const managers = await candidates(o.pool);
  let sent = 0;
  for (const t of due) {
    const hours = Math.floor((now.getTime() - t.due_at.getTime()) / H);
    const first = t.assignee.split(" ")[0] || t.assignee;
    for (const m of managers) {
      if (m.userId === t.assignee_id || !(m.isOwner || manages(m, t.assignee_id)) || !sees(m, t.owner_id))
        continue;
      const id = await notify(o.pool, m.userId, {
        kind: "task_escalated",
        title: `${first}'s follow-up with ${t.lead} is ${overdueWords(hours)} overdue`,
        leadId: t.lead_id,
        taskId: t.id,
        data: { assigneeId: t.assignee_id },
      }).catch((err: unknown) => {
        o.app.log.error({ err }, "couldn't send an escalation");
        return null;
      });
      if (id) sent++;
    }
  }
  return sent;
}

/** Everyone who might manage someone's follow-ups: the owner, and holders of Manage others' follow-ups. */
async function candidates(pool: pg.Pool): Promise<Actor[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.status = 'active' AND (u.is_owner OR EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = u.id AND rp.permission_key = 'tasks.manage_others'))`,
  );
  const out: Actor[] = [];
  for (const r of rows) {
    const a = await loadActor(pool, r.id);
    if (a) out.push(a);
  }
  return out;
}

/** How long overdue, read at a glance: "30 h" under two days, then "6 days" (never "164 h"). */
export function overdueWords(hours: number): string {
  return hours < 48 ? `${hours} h` : plural(Math.floor(hours / 24), "day");
}
