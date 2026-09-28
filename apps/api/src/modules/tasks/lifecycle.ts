import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import { cancelReminders } from "./engine";

const T = schema.tasks;

/** The lead's next open follow-up, for lists that sort and filter by it (Phase 3 spec §3). */
export async function refreshNextDue(req: FastifyRequest, leadId: string) {
  await req.db.execute(
    sql`UPDATE leads SET next_task_due_at = (SELECT min(due_at) FROM tasks WHERE lead_id = ${leadId} AND status = 'open') WHERE id = ${leadId}`,
  );
}

/**
 * Once this request commits, the follow-up's reminders stop waiting to be read: it was done, cancelled or
 * moved, so a reminder of it has nothing left to say (3B final review, Important 2). As its assignee, since
 * notifications are only ever their own — whoever did it.
 */
export async function settleReminders(req: FastifyRequest, t: { id: string; assigneeId: string }) {
  // Your own: in this transaction, so whatever you look at next already has them read.
  if (req.actor?.userId === t.assigneeId) {
    await req.db.execute(
      sql`UPDATE notifications SET read_at = now()
           WHERE task_id = ${t.id} AND read_at IS NULL AND kind IN ('follow_up_due', 'follow_up_soon', 'follow_up_nudge')`,
    );
    return;
  }
  // Someone else's: theirs to read as them, once this commits.
  req.afterCommit(() => {
    req.server
      .settleReminders?.(t.assigneeId, t.id)
      .catch((err: unknown) => req.log.error({ err }, "couldn't mark a follow-up's reminders read"));
  });
}

/** A lead removed: its open follow-ups are cancelled, and their reminders with them (spec §3). */
export async function cancelLeadTasks(req: FastifyRequest, leadId: string) {
  const open = await req.db
    .update(T)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(T.leadId, leadId), eq(T.status, "open")))
    .returning({ id: T.id, assigneeId: T.assigneeId });
  for (const t of open) {
    await cancelReminders(req.db, t.id);
    await settleReminders(req, t);
  }
  await refreshNextDue(req, leadId);
}
