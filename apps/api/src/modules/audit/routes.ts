import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import Papa from "papaparse";
import { z } from "zod";
import { auditWords, can } from "@lume/core/shared";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { safeCell } from "../../export/service";
import { HttpError } from "../../http/errors";

/** What the screen filters by, and so what the download follows. */
const filters = {
  action: z.string().max(80).optional(),
  actorUserId: z.uuid().optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(80).optional(),
  /** One day on the business's clock (6C: a Security figure opens its own entries). */
  day: z.iso.date().optional(),
};
type Filters = { [K in keyof typeof filters]?: string };

const businessTz = async (req: FastifyRequest) => {
  const [s] = await req.db.select({ tz: schema.settings.timezone }).from(schema.settings);
  return s?.tz ?? "UTC";
};

function whereOf(q: Filters, tz: string): SQL[] {
  const where: SQL[] = [];
  if (q.action) where.push(eq(schema.auditLog.action, q.action));
  if (q.actorUserId) where.push(eq(schema.auditLog.actorUserId, q.actorUserId));
  if (q.entityType) where.push(eq(schema.auditLog.entityType, q.entityType));
  if (q.entityId) where.push(eq(schema.auditLog.entityId, q.entityId));
  if (q.day)
    where.push(
      sql`${schema.auditLog.at} >= (${q.day}::date::timestamp AT TIME ZONE ${tz})`,
      sql`${schema.auditLog.at} < ((${q.day}::date + 1)::timestamp AT TIME ZONE ${tz})`,
    );
  return where;
}

/** Rows read at a time for the download, so a long log never sits in one query. */
const BATCH = 2000;

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
          ...filters,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const where = whereOf(q, q.day ? await businessTz(req) : "UTC");
      if (q.cursor) where.push(lt(schema.auditLog.id, q.cursor));
      // Who did it, by name, so reading the log needs no other access (the people list needs leads.view).
      const rows = await req.db
        .select({ entry: schema.auditLog, actorName: schema.users.name })
        .from(schema.auditLog)
        .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
        .where(and(...where))
        .orderBy(desc(schema.auditLog.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit).map((r) => ({ ...r.entry, actorName: r.actorName ?? null }));
      return { entries: page, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    },
  );

  // The log as a CSV (owner 2026-11-14): what the screen shows, in the same words and with the same filters, every
  // entry rather than a page. Reading the log and audit.export are the gates; the download is itself in the log.
  r.get(
    "/api/v1/audit/csv",
    { config: { permission: "audit.view" }, schema: { querystring: z.object(filters) } },
    async (req, reply) => {
      // Reading the log opens the page; taking it away is its own permission (owner 2026-11-14), said in words.
      if (!can(req.actor!, "audit.export"))
        throw new HttpError(403, "NO_AUDIT_EXPORT", "Downloading the audit log needs its own permission.");
      const q = req.query;
      const tz = await businessTz(req);
      const where = whereOf(q, tz);
      const out: string[][] = [[`When (${tz})`, "Who", "What happened", "Item", "Item ID"]];
      for (let after: number | null = null; ;) {
        const rows = await req.db
          .select({
            id: schema.auditLog.id,
            when: sql<string>`to_char(${schema.auditLog.at} AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI')`,
            actorUserId: schema.auditLog.actorUserId,
            actorName: schema.users.name,
            action: schema.auditLog.action,
            entityType: schema.auditLog.entityType,
            entityId: schema.auditLog.entityId,
            diff: schema.auditLog.diff,
          })
          .from(schema.auditLog)
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
          .where(and(...where, ...(after === null ? [] : [lt(schema.auditLog.id, after)])))
          .orderBy(desc(schema.auditLog.id))
          .limit(BATCH);
        for (const e of rows)
          out.push([
            e.when,
            e.actorUserId ? (e.actorName ?? "Someone") : "LUME",
            auditWords(e.action, e.diff as Record<string, unknown>) ?? e.action,
            e.entityType,
            e.entityId ?? "",
          ]);
        if (rows.length < BATCH) break;
        after = rows.at(-1)!.id;
      }
      const safe = out.map((row, i) => (i === 0 ? row : row.map((v) => String(safeCell(v) ?? ""))));
      const body = `\uFEFF${Papa.unparse(safe, { newline: "\r\n" })}\r\n`;
      await audit(req, {
        action: "audit.export",
        entityType: "audit",
        diff: { rows: out.length - 1, ...q },
      });
      const [today] = (
        await req.db.execute<{ d: string }>(sql`SELECT to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS d`)
      ).rows;
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="lume-audit-log-${today!.d}.csv"`)
        .header("cache-control", "no-store")
        .send(body);
    },
  );
}
