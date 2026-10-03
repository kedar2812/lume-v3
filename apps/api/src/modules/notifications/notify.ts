import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { mergePreferences, type Preferences } from "@lume/core";
import { readAs } from "./hub";

export type NotifyKind =
  | "follow_up_due"
  | "follow_up_soon"
  | "follow_up_assigned"
  | "lead_assigned"
  | "task_escalated"
  | "follow_up_nudge"
  | "lead_stage"
  | "system_alert"
  | "calendar_reconnect"
  | "meeting_booked"
  | "meeting_cancelled"
  | "security_alert"
  | "bulk_done";
export type NewNotification = {
  kind: NotifyKind;
  /** A lead's name at most: never a phone number or email (Phase 3 spec §4). */
  title: string;
  body?: string | null;
  leadId?: string | null;
  taskId?: string | null;
  data?: Record<string, unknown>;
};

/** Which of a person's alert switches (Settings → My account) each kind answers to. */
const SWITCH: Partial<Record<NotifyKind, keyof Preferences["alerts"]>> = {
  follow_up_due: "dueFollowUps",
  follow_up_soon: "dueFollowUps",
  follow_up_assigned: "assigned",
  lead_assigned: "assigned",
};
/**
 * Whether this person wants this kind. Escalations to managers, and a manager's "Remind them", always go:
 * they're the safety net, and a manager who asked is told it was sent (3B final review).
 */
export function wants(stored: unknown, kind: NotifyKind): boolean {
  const s = SWITCH[kind];
  return !s || mergePreferences(stored, {}).alerts[s];
}

/**
 * Write a notification as its recipient (their own row-level security) and tell the live stream. Nothing
 * for someone who isn't active, or who switched that kind off. Returns its id, or null when skipped.
 */
export async function notify(pool: pg.Pool, userId: string, n: NewNotification): Promise<number | null> {
  const { rows } = await pool.query<{ preferences: unknown; status: string }>(
    "SELECT preferences, status FROM users WHERE id = $1",
    [userId],
  );
  const u = rows[0];
  if (!u || u.status !== "active" || !wants(u.preferences, n.kind)) return null;
  return readAs(pool, userId, async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, task_id, lead_id, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, n.kind, n.taskId ?? null, n.leadId ?? null, n.title, n.body ?? null, n.data ?? {}],
    );
    const id = Number(ins.rows[0]!.id);
    await c.query("SELECT pg_notify('lume_notifications', $1)", [JSON.stringify({ u: userId, n: id })]);
    return id;
  });
}

declare module "fastify" {
  interface FastifyInstance {
    /** Send a notification (3B): as its recipient, if they want it. */
    notify?: (userId: string, n: NewNotification) => Promise<number | null>;
    /** A person's first name, for notices ("assigned to you by Maya"). */
    notifyNameOf?: (userId: string) => Promise<string | null>;
    /** Mark a follow-up's reminders read for its assignee: it was done, cancelled or moved (3B final review). */
    settleReminders?: (userId: string, taskId: string) => Promise<void>;
  }
}

/** Leads handed to someone in this request, gathered so fifty at once make one notice, not fifty. */
const handed = new WeakMap<FastifyRequest, Map<string, { names: string[]; leadId: string }>>();

/** Tell `userId` a lead is now theirs, once this request commits (3B Task 2; the owner is told, not the actor). */
export function noteAssigned(req: FastifyRequest, userId: string, lead: { id: string; name: string }) {
  if (userId === req.actor?.userId || !req.server.notify) return;
  let byUser = handed.get(req);
  if (!byUser) {
    handed.set(req, (byUser = new Map()));
    const by = req.actor?.userId;
    req.afterCommit(() => {
      const send = req.server.notify!;
      void (async () => {
        const who = by ? ((await req.server.notifyNameOf?.(by)) ?? "someone") : "someone";
        for (const [to, got] of byUser!) {
          const title =
            got.names.length === 1
              ? `${got.names[0]} was assigned to you by ${who}`
              : `${got.names.length} leads were assigned to you by ${who}`;
          await send(to, {
            kind: "lead_assigned",
            title,
            leadId: got.names.length === 1 ? got.leadId : null,
          }).catch((err: unknown) => req.log.error({ err }, "couldn't send an assignment notice"));
        }
      })();
    });
  }
  const got = byUser.get(userId) ?? { names: [], leadId: lead.id };
  got.names.push(lead.name);
  byUser.set(userId, got);
}
