import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/api/v1/audit",
    {
      config: { permission: "audit.view" },
      schema: {
        querystring: z.object({
          cursor: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          action: z.string().max(80).optional(),
          actorUserId: z.uuid().optional(),
          entityType: z.string().max(40).optional(),
          entityId: z.string().max(80).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const where: SQL[] = [];
      if (q.cursor) where.push(lt(schema.auditLog.id, q.cursor));
      if (q.action) where.push(eq(schema.auditLog.action, q.action));
      if (q.actorUserId) where.push(eq(schema.auditLog.actorUserId, q.actorUserId));
      if (q.entityType) where.push(eq(schema.auditLog.entityType, q.entityType));
      if (q.entityId) where.push(eq(schema.auditLog.entityId, q.entityId));
      const rows = await req.db
        .select()
        .from(schema.auditLog)
        .where(and(...where))
        .orderBy(desc(schema.auditLog.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { entries: page, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    },
  );
}
