import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  canOnRecord,
  CLEAN_KINDS,
  CLOSED_MONTHS,
  DEFAULT_CLOSED_MONTHS,
  DEFAULT_WARN_AT,
  WARN_AT,
  type ClosedMonths,
} from "@lume/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { notFound } from "../../http/errors";
import { safeCell } from "../../export/service";
import { KEEP_MONTHS } from "../whatsapp/keep";
import { cleanupOf, runningCleanup, startCleanup } from "./clean";
import { forgetSurvey, PARAMS_CTE, PARTS, partParams, survey } from "./survey";

/** Rows the list of what a clean-up would clear holds at most (a last line says when it stopped there). */
export const CSV_MAX_ROWS = 50_000;

const months = z.coerce
  .number()
  .int()
  .refine((n) => (CLOSED_MONTHS as readonly number[]).includes(n), "Pick 3, 6, 12 or 24 months.");

/** The storage settings as they're kept (settings.integrations): one keep-for for every chat, the warning's mark. */
export async function storageSettings(d: AppDeps) {
  const r = await d.pool.query<{ keep: unknown; warn: unknown }>(
    `SELECT integrations -> 'whatsapp' -> 'keepFilesMonths' AS keep, integrations -> 'storage' -> 'warnAtPct' AS warn
       FROM settings WHERE id = 1`,
  );
  const keep = KEEP_MONTHS.safeParse(r.rows[0]?.keep ?? null);
  const warn = Number(r.rows[0]?.warn);
  return {
    keepFilesMonths: keep.success ? keep.data : null,
    warnAtPct: (WARN_AT as readonly number[]).includes(warn)
      ? (warn as (typeof WARN_AT)[number])
      : DEFAULT_WARN_AT,
  };
}

/** Settings › Storage (plan 2026-11-23-storage-clean-up): admins only. */
export async function storageRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const admin = { config: { permission: "settings.manage" as const } };
  r.get(
    "/api/v1/storage",
    { ...admin, schema: { querystring: z.object({ closedMonths: months.optional() }).strict() } },
    async (req) => ({
      ...(await survey(d.jobPool ?? d.pool, d.files ?? undefined, {
        closedMonths: req.query.closedMonths ?? DEFAULT_CLOSED_MONTHS,
        now: d.clock(),
      })),
      settings: await storageSettings(d),
      running: await runningCleanup(d.jobPool ?? d.pool),
    }),
  );
  // Clean up: what to clear; 202 with its progress to watch, or 409 with the one already running.
  r.post(
    "/api/v1/storage/clean-up",
    {
      ...admin,
      schema: {
        body: z
          .object({
            kinds: z
              .array(z.enum(CLEAN_KINDS))
              .min(1)
              .max(CLEAN_KINDS.length)
              .refine((k) => new Set(k).size === k.length, "Each kind once."),
            closedMonths: months.optional(),
          })
          .strict(),
      },
    },
    async (req, reply) =>
      reply.code(202).send(
        await startCleanup(req, d, {
          kinds: req.body.kinds,
          closedMonths: (req.body.closedMonths ?? DEFAULT_CLOSED_MONTHS) as ClosedMonths,
        }),
      ),
  );
  r.get(
    "/api/v1/storage/clean-up/:id",
    { ...admin, schema: { params: z.object({ id: z.uuid() }) } },
    async (req) => {
      const c = await cleanupOf(d.jobPool ?? d.pool, req.params.id);
      if (!c) throw notFound();
      return c;
    },
  );
  // "List the files first": every file these kinds would clear, before anything is (this LUME only; formula-safe).
  r.get(
    "/api/v1/storage/clean-up/files.csv",
    {
      ...admin,
      schema: {
        querystring: z
          .object({
            kinds: z
              .string()
              .transform((s) => s.split(",").filter(Boolean))
              .pipe(z.array(z.enum(CLEAN_KINDS)).min(1)),
            closedMonths: months.optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const pool = d.jobPool ?? d.pool;
      const params = partParams(req.query.closedMonths ?? DEFAULT_CLOSED_MONTHS);
      const lines = ["What,Lead,File,Size (bytes),Added"];
      // The clean-up reaches every lead; the list shows a lead's name and file names only to an admin who may see
      // that lead (whose leads they see is their role's, as everywhere else).
      const mayName = (owner: string | null) => canOnRecord(req.actor!, "leads.view", owner);
      let listed = 0;
      const c = await pool.connect();
      try {
        await c.query("BEGIN READ ONLY");
        await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
        for (const kind of req.query.kinds)
          for (const p of PARTS[kind]) {
            const lead = p.table === "whatsapp_media" || p.table === "instagram_media";
            const room = CSV_MAX_ROWS - listed;
            if (room <= 0) break;
            // Only LUME's own constants are joined in (PARTS' tables, columns and conditions); every value, the row
            // limit too, is a parameter.
            const name = p.table === "whatsapp_media" ? "coalesce(x.filename, x.kind)" : "x.kind";
            const list = lead
              ? `WITH ${PARAMS_CTE} SELECT l.name AS lead, l.owner_id AS owner, ${name} AS name, x.size::text, x.created_at AS at
                   FROM ${p.table} x LEFT JOIN leads l ON l.id = x.lead_id WHERE ${p.where} LIMIT $4`
              : p.table === "message_files"
                ? `WITH ${PARAMS_CTE} SELECT NULL AS lead, NULL::uuid AS owner, x.name, x.size::text, x.created_at AS at
                     FROM message_files x WHERE ${p.where} LIMIT $4`
                : `WITH ${PARAMS_CTE} SELECT NULL AS lead, NULL::uuid AS owner, 'Preview' AS name, NULL AS size,
                          x.opened_at AS at FROM file_previews x WHERE ${p.where} LIMIT $4`;
            const rows = await c.query<{
              lead: string | null;
              owner: string | null;
              name: string | null;
              size: string | null;
              at: Date | null;
            }>(list, [...params, room]);
            listed += rows.rows.length;
            for (const row of rows.rows) {
              const hidden = lead && !mayName(row.owner);
              lines.push(
                [
                  kind,
                  hidden ? "A lead you can't see" : (row.lead ?? ""),
                  hidden ? "" : (row.name ?? ""),
                  row.size ?? "",
                  row.at ? new Date(row.at).toISOString().slice(0, 10) : "",
                ]
                  .map((v) => `"${String(safeCell(v)).replace(/"/g, '""')}"`)
                  .join(","),
              );
            }
          }
        await c.query("COMMIT");
      } catch (e) {
        // Never back to the pool mid-transaction: the next request on this connection would fail.
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      if (listed >= CSV_MAX_ROWS)
        lines.push(`"","","LUME listed the first ${CSV_MAX_ROWS.toLocaleString("en")} files.","",""`);
      // A list of lead names and their files leaving LUME: on the record, as every export is.
      await audit(req, {
        action: "storage.listed",
        entityType: "storage_cleanup",
        entityId: null,
        diff: { kinds: req.query.kinds, rows: listed },
      });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="storage-clean-up.csv"')
        .header("cache-control", "no-store")
        .send(`${lines.join("\r\n")}\r\n`);
    },
  );
  // The settings: one keep-for for every chat's files, and the mark at which the admins hear.
  r.put(
    "/api/v1/storage/settings",
    {
      ...admin,
      schema: {
        body: z
          .object({
            warnAtPct: z
              .number()
              .int()
              .refine((n) => (WARN_AT as readonly number[]).includes(n), "Pick 70, 80 or 90.")
              .optional(),
            keepFilesMonths: KEEP_MONTHS.optional(),
          })
          .strict()
          .refine((b) => b.warnAtPct !== undefined || b.keepFilesMonths !== undefined, "Nothing to change."),
      },
    },
    async (req) => {
      const before = await storageSettings(d);
      if (req.body.warnAtPct !== undefined)
        await req.db.execute(
          sql`UPDATE settings SET integrations = jsonb_set(coalesce(integrations, '{}'::jsonb), '{storage}',
                coalesce(integrations -> 'storage', '{}'::jsonb) || jsonb_build_object('warnAtPct', ${req.body.warnAtPct}::int))
               WHERE id = 1`,
        );
      if (req.body.keepFilesMonths !== undefined)
        await req.db.execute(
          sql`UPDATE settings SET integrations = jsonb_set(coalesce(integrations, '{}'::jsonb), '{whatsapp}',
                coalesce(integrations -> 'whatsapp', '{}'::jsonb) || jsonb_build_object('keepFilesMonths', ${req.body.keepFilesMonths}::int))
               WHERE id = 1`,
        );
      await audit(req, {
        action: "storage.settings",
        entityType: "settings",
        diff: {
          ...(req.body.warnAtPct !== undefined
            ? { warnAtPct: { from: before.warnAtPct, to: req.body.warnAtPct } }
            : {}),
          ...(req.body.keepFilesMonths !== undefined
            ? { keepFilesMonths: { from: before.keepFilesMonths, to: req.body.keepFilesMonths } }
            : {}),
        },
      });
      forgetSurvey();
      return { settings: { ...before, ...req.body } };
    },
  );
}
