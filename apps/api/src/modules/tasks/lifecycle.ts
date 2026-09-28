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

/** A lead removed: its open follow-ups are cancelled, and their reminders with them (spec §3). */
export async function cancelLeadTasks(req: FastifyRequest, leadId: string) {
  const open = await req.db
    .update(T)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(T.leadId, leadId), eq(T.status, "open")))
    .returning({ id: T.id });
  for (const t of open) await cancelReminders(req.db, t.id);
  await refreshNextDue(req, leadId);
}
