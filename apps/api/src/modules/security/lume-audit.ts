import { schema } from "@lume/db";
import type { Db } from "../../db/context";

/**
 * An audit entry for what LUME itself did (an alert, a pause, telling admins): no person acted, so no actor
 * unless one is named. Written on whatever connection the act runs on — a request's, or the sweep's.
 */
export async function lumeAudit(
  db: Db,
  e: {
    action: string;
    entityType: string;
    entityId: string;
    diff: Record<string, unknown>;
    actorUserId?: string;
  },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    diff: e.diff,
  });
}
