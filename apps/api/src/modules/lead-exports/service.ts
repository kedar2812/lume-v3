import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { checkRow, newExportCode, newId, type Keyring, initialsOf } from "@lume/core";
import { resolveDrill } from "../analytics/drill";
import { audit } from "../../audit/audit";
import { HttpError, notFound } from "../../http/errors";
import type { FilterQuery } from "../leads/query";
import { buildRows, carriesCheckRow, readView, toCsv, toXlsx } from "./make";

const DAY_MS = 24 * 3_600_000;
const context = (id: string) => `lead-export:${id}`;
const initials = initialsOf;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export type ExportInput = {
  format: "csv" | "xlsx";
  label: string;
  filters: FilterQuery & { sort?: "newest" | "oldest" | "updated" | "name"; drill?: string };
  columns: string[];
};
type Row = {
  id: string;
  code: string;
  label: string;
  format: "csv" | "xlsx";
  row_count: number;
  created_at: Date | string;
  expires_at: Date | string;
  cleared_at: Date | string | null;
  downloads: number;
  user_id: string;
  name: string;
};
const view = (r: Row) => ({
  id: r.id,
  code: r.code,
  label: r.label,
  format: r.format,
  rows: r.row_count,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
  available: !r.cleared_at && new Date(r.expires_at).getTime() > Date.now(),
  downloads: r.downloads,
  who: { id: r.user_id, name: r.name, initials: initials(r.name) },
});
export type ExportView = ReturnType<typeof view>;
const SELECT = sql`
  SELECT e.id, e.code, e.label, e.format, e.row_count, e.created_at, e.expires_at, e.cleared_at, e.downloads,
         e.user_id, u.name
    FROM lead_exports e JOIN users u ON u.id = e.user_id`;

/** A code nobody has used: eight characters from 31 make a clash vanishingly rare, but never impossible. */
async function freshCode(req: FastifyRequest): Promise<string> {
  for (;;) {
    const code = newExportCode();
    const { rows } = await req.db.execute(sql`SELECT 1 FROM lead_exports WHERE code = ${code}`);
    if (!rows.length) return code;
  }
}

/**
 * Export the current view (spec §3): read as the person, marked (the code on every row, and one check row),
 * sealed with the instance keyring into its own row for 24 hours (plan rulings B1, B2), and audited.
 */
export async function makeExport(
  req: FastifyRequest,
  keyring: Keyring,
  input: ExportInput,
  now = new Date(),
): Promise<{ export: ExportView }> {
  // The leads behind a number on Analytics (8D): its token becomes their ids, read and checked as Analytics reads it.
  const { drill, ...filters } = input.filters;
  const ids = drill ? await resolveDrill(req, keyring, now, drill) : undefined;
  const { columns, views, lookups } = await readView(
    req,
    {
      ...filters,
      ...(ids ? { ids: filters.ids ? filters.ids.filter((id) => ids.includes(id)) : ids } : {}),
      sort: filters.sort ?? "newest",
    },
    input.columns,
  );
  const id = newId();
  const code = await freshCode(req);
  const check = checkRow();
  const position = carriesCheckRow(columns) ? randomInt(views.length + 1) : null;
  const built = buildRows(columns, views, lookups, { code, check, position });
  const file = input.format === "csv" ? toCsv(built) : await toXlsx(built);
  const sealed = keyring.encrypt(file.toString("base64"), context(id));
  const columnIds = `{${columns.map((c) => `"${c.id}"`).join(",")}}`;
  await req.db.execute(sql`
    INSERT INTO lead_exports (id, user_id, code, label, format, filters, columns, row_count, check_name,
                              check_email, check_phone, check_position, file_enc, expires_at)
    VALUES (${id}, ${req.actor!.userId}, ${code}, ${input.label}, ${input.format},
            ${JSON.stringify(input.filters)}::jsonb, ${columnIds}::text[], ${built.leads},
            ${check.name}, ${check.email}, ${check.phone}, ${position}, ${sealed},
            ${new Date(Date.now() + DAY_MS)})`);
  await audit(req, {
    action: "lead.export",
    entityType: "lead_export",
    entityId: id,
    diff: { code, rows: built.leads, format: input.format, label: input.label },
  });
  const [r] = (await req.db.execute(sql`${SELECT} WHERE e.id = ${id}`)).rows as Row[];
  return { export: view(r!) };
}

/** Every export of the last 90 days, newest first, for people who manage security. */
export async function listExports(req: FastifyRequest): Promise<{ exports: ExportView[] }> {
  const rows = (
    await req.db.execute(
      sql`${SELECT} WHERE e.created_at > now() - interval '90 days' ORDER BY e.created_at DESC LIMIT 300`,
    )
  ).rows as Row[];
  return { exports: rows.map(view) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type FileRow = {
  code: string;
  format: "csv" | "xlsx";
  file_enc: Buffer | null;
  expires_at: Date | string;
  created_at: Date | string;
  user_id: string;
};

/** The file, for the person who made it, while it lasts (plan ruling B5); each download audited. */
export async function downloadExport(req: FastifyRequest, reply: FastifyReply, keyring: Keyring, id: string) {
  const { rows } = await req.db.execute(sql`
    SELECT code, format, file_enc, expires_at, created_at, user_id FROM lead_exports WHERE id = ${id} FOR UPDATE`);
  const e = rows[0] as FileRow | undefined;
  if (!e || e.user_id !== req.actor!.userId) throw notFound("NOT_FOUND", "That export isn't here");
  if (!e.file_enc || new Date(e.expires_at).getTime() <= Date.now())
    throw new HttpError(410, "EXPIRED", "This file has expired. Export the view again.");
  const file = Buffer.from(keyring.decrypt(e.file_enc, context(id)), "base64");
  await req.db.execute(
    sql`UPDATE lead_exports SET downloads = downloads + 1, last_downloaded_at = now() WHERE id = ${id}`,
  );
  await audit(req, {
    action: "lead.export.download",
    entityType: "lead_export",
    entityId: id,
    diff: { code: e.code, device: req.headers["user-agent"]?.slice(0, 300) ?? null },
  });
  const made = new Date(e.created_at);
  const name = `LUME leads ${MONTHS[made.getUTCMonth()]} ${made.getUTCDate()} ${e.code}.${e.format}`;
  return reply
    .header("cache-control", "no-store")
    .header(
      "content-type",
      e.format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .header("content-disposition", `attachment; filename="${name}"`)
    .send(file);
}

/** Hourly: files past their 24 hours are removed; the row (code, check row, counts) stays for tracing. */
export async function clearExpiredExports(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    "UPDATE lead_exports SET file_enc = NULL, cleared_at = now() WHERE file_enc IS NOT NULL AND expires_at < now()",
  );
  return r.rowCount ?? 0;
}
