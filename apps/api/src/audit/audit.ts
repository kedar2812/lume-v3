import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";

export type AuditEvent = {
  action: string;
  entityType: string;
  entityId?: string | null;
  diff?: Record<string, unknown>;
  actorUserId?: string | null;
};

/** Written in the request's own transaction: if the change rolls back, so does its audit entry. */
export async function audit(req: FastifyRequest, e: AuditEvent): Promise<void> {
  await req.db.insert(schema.auditLog).values({
    actorUserId: e.actorUserId !== undefined ? e.actorUserId : (req.actor?.userId ?? null),
    actorIp: req.ip ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    diff: e.diff ?? {},
    requestId: String(req.id),
  });
}
