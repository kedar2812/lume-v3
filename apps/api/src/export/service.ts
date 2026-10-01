import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import ExcelJS from "exceljs";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import Papa from "papaparse";
import { audit } from "../audit/audit";

/** Rows read at a time: a big install is never held in memory whole. */
const BATCH = 1000;

type Cell = string | number | null;
type Table = {
  file: string;
  sheet: string;
  columns: string[];
  /** Keyset pages: the SQL takes the last key seen ($1) and the batch size ($2), ordered by key. */
  rows: (c: pg.PoolClient) => AsyncGenerator<Cell[]>;
};

async function* pages<R extends Record<string, unknown>>(
  c: pg.PoolClient,
  sql: string,
  key: keyof R & string,
  first: unknown,
  map: (r: R) => Cell[],
): AsyncGenerator<Cell[]> {
  let after: unknown = first;
  for (;;) {
    const { rows } = await c.query<R>(sql, [after, BATCH]);
    for (const r of rows) yield map(r);
    if (rows.length < BATCH) return;
    after = rows.at(-1)![key];
  }
}
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : ((d as string | null) ?? null));
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** The custom fields, in their order, and how each stored value reads in words. */
async function customFields(c: pg.PoolClient) {
  const { rows: fields } = await c.query<{
    key: string;
    label: string;
    type: string;
    options: { id: string; label: string }[];
  }>("SELECT key, label, type, options FROM field_definitions WHERE NOT is_core ORDER BY position, key");
  const { rows: people } = await c.query<{ id: string; name: string }>("SELECT id, name FROM users");
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const words = (f: (typeof fields)[number], v: unknown): Cell => {
    if (v === undefined || v === null || v === "") return null;
    const label = (id: unknown) => f.options.find((o) => o.id === id)?.label ?? String(id);
    if (f.type === "select") return label(v);
    if (f.type === "multi_select") return (Array.isArray(v) ? v : [v]).map(label).join(", ");
    if (f.type === "user") return nameOf.get(String(v)) ?? String(v);
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return typeof v === "number" ? v : String(v);
  };
  return { fields, words };
}

async function tables(c: pg.PoolClient): Promise<Table[]> {
  const { fields, words } = await customFields(c);
  const leadCols = [
    "Lead ID",
    "Name",
    "Phone",
    "Email",
    "Instagram",
    "Pipeline",
    "Stage",
    "Owner",
    "Value",
    "Currency",
    "Tags",
    "Source",
    "Product",
    "External ref",
    "Lost reason",
    "Lost note",
    "Enquiry date",
    "Created",
    "Last activity",
    "Won",
    "Lost",
    ...fields.map((f) => f.label),
  ];
  return [
    {
      file: "leads.csv",
      sheet: "Leads",
      columns: leadCols,
      rows: (cl) =>
        pages<Record<string, unknown>>(
          cl,
          `SELECT l.id, l.name, coalesce(l.phone_e164, l.phone_raw) AS phone, l.email, l.instagram_handle,
                  p.name AS pipeline, s.name AS stage, u.name AS owner, l.value, l.currency,
                  (SELECT string_agg(t.label::text, ', ' ORDER BY t.label) FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
                    WHERE lt.lead_id = l.id) AS tags,
                  ls.name AS source, pr.name::text AS product, l.external_ref,
                  lr.label AS lost_reason, l.lost_note, l.lead_created_at, l.created_at, l.last_activity_at,
                  l.won_at, l.lost_at, l.custom
             FROM leads l
             JOIN pipelines p ON p.id = l.pipeline_id
             JOIN stages s ON s.id = l.stage_id
             LEFT JOIN users u ON u.id = l.owner_id
             LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
             LEFT JOIN lead_sources ls ON ls.id = l.source_id
             LEFT JOIN products pr ON pr.id = l.product_id
            WHERE l.deleted_at IS NULL AND l.id > $1::uuid
            ORDER BY l.id LIMIT $2`,
          "id",
          ZERO_UUID,
          (r) => {
            const custom = (r.custom ?? {}) as Record<string, unknown>;
            return [
              r.id as string,
              r.name as string,
              (r.phone as string) ?? null,
              (r.email as string) ?? null,
              (r.instagram_handle as string) ?? null,
              r.pipeline as string,
              r.stage as string,
              (r.owner as string) ?? null,
              r.value === null ? null : Number(r.value),
              (r.currency as string) ?? null,
              (r.tags as string) ?? null,
              (r.source as string) ?? null,
              (r.product as string) ?? null,
              (r.external_ref as string) ?? null,
              (r.lost_reason as string) ?? null,
              (r.lost_note as string) ?? null,
              (r.lead_created_at as string) ?? null,
              iso(r.created_at),
              iso(r.last_activity_at),
              iso(r.won_at),
              iso(r.lost_at),
              ...fields.map((f) => words(f, custom[f.key])),
            ];
          },
        ),
    },
    {
      file: "notes.csv",
      sheet: "Notes",
      columns: ["Lead ID", "Lead", "Author", "Note", "Written"],
      rows: (cl) =>
        pages<Record<string, unknown>>(
          cl,
          `SELECT a.id, a.lead_id, l.name AS lead, u.name AS author, a.payload->>'body' AS body, a.occurred_at
             FROM activities a JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
            WHERE a.type = 'note' AND l.deleted_at IS NULL AND a.id > $1::uuid ORDER BY a.id LIMIT $2`,
          "id",
          ZERO_UUID,
          (r) => [
            r.lead_id as string,
            r.lead as string,
            (r.author as string) ?? null,
            (r.body as string) ?? null,
            iso(r.occurred_at),
          ],
        ),
    },
    {
      file: "activity.csv",
      sheet: "Activity",
      columns: ["Lead ID", "Lead", "What", "By", "When", "Details"],
      rows: (cl) =>
        pages<Record<string, unknown>>(
          cl,
          `SELECT a.id, a.lead_id, l.name AS lead, a.type, u.name AS who, a.occurred_at, a.payload
             FROM activities a JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
            WHERE l.deleted_at IS NULL AND a.id > $1::uuid ORDER BY a.id LIMIT $2`,
          "id",
          ZERO_UUID,
          (r) => [
            r.lead_id as string,
            r.lead as string,
            r.type as string,
            (r.who as string) ?? null,
            iso(r.occurred_at),
            r.payload && Object.keys(r.payload as object).length ? JSON.stringify(r.payload) : null,
          ],
        ),
    },
    {
      file: "follow-ups.csv",
      sheet: "Follow-ups",
      columns: ["Lead ID", "Lead", "Title", "Note", "Due", "Status", "Assigned to", "Done"],
      rows: (cl) =>
        pages<Record<string, unknown>>(
          cl,
          `SELECT t.id, t.lead_id, l.name AS lead, t.title, t.note, t.due_at, t.status, u.name AS assignee, t.done_at
             FROM tasks t JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assignee_id
            WHERE l.deleted_at IS NULL AND t.id > $1::uuid ORDER BY t.id LIMIT $2`,
          "id",
          ZERO_UUID,
          (r) => [
            r.lead_id as string,
            r.lead as string,
            r.title as string,
            (r.note as string) ?? null,
            iso(r.due_at),
            r.status as string,
            (r.assignee as string) ?? null,
            iso(r.done_at),
          ],
        ),
    },
    {
      file: "users.csv",
      sheet: "Users",
      columns: ["Name", "Email", "Roles", "Status", "Owner", "Joined", "Last sign-in"],
      rows: (cl) =>
        pages<Record<string, unknown>>(
          cl,
          `SELECT u.id, u.name, u.email, u.status, u.is_owner, u.created_at, u.last_login_at,
                  (SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND r.deleted_at IS NULL) AS roles
             FROM users u WHERE u.id > $1::uuid ORDER BY u.id LIMIT $2`,
          "id",
          ZERO_UUID,
          (r) => [
            r.name as string,
            r.email as string,
            (r.roles as string) ?? null,
            r.status as string,
            r.is_owner ? "Yes" : "No",
            iso(r.created_at),
            iso(r.last_login_at),
          ],
        ),
    },
  ];
}

/**
 * A cell a spreadsheet would run as a formula is written with a leading ' (lead names come from public forms
 * and webhooks, and must never become a live formula on someone's computer): anything starting with = or @,
 * a tab or a return, and a + or - that isn't simply a number (a phone number like +971 50 111 2233 stays).
 */
const RUNS = /^[=@\t\r]/;
const PLAIN_NUMBER = /^[+-][\d\s().-]*$/;
export const safeCell = (v: Cell): Cell =>
  typeof v === "string" && (RUNS.test(v) || (/^[+-]/.test(v) && !PLAIN_NUMBER.test(v))) ? `'${v}` : v;
const csvLine = (cells: Cell[]) =>
  `${Papa.unparse([cells.map((v) => (v === null ? "" : safeCell(v)))], { newline: "\r\n" })}\r\n`;

/** Writes, waiting whenever the zip is behind: memory stays flat however many rows there are. */
async function write(out: Writable, chunk: string, signal: AbortSignal) {
  if (!out.write(chunk)) await once(out, "drain", { signal });
}

/** Excel's own limits: rows per sheet (after the header), and characters per cell. */
const SHEET_ROWS = 1_048_575;
const CELL_CHARS = 32_767;
const fitCell = (v: Cell): Cell =>
  typeof v === "string" && v.length > CELL_CHARS
    ? `${v.slice(0, CELL_CHARS - 40)}… (cut to fit; see the CSV)`
    : v;

/**
 * Reads everything and writes it into the zip (spec §3.6): five CSVs streamed as they're read, then one
 * workbook built in a temporary file (so a slow download never piles it up in memory). On its own
 * connection, in one read-only transaction, as LUME itself: every lead, unmasked. If the download is
 * abandoned (`signal`), it stops, rolls back and lets the connection go.
 */
export async function produceExport(o: {
  pool: pg.Pool;
  userId: string;
  zip: archiver.Archiver;
  signal: AbortSignal;
  log: FastifyBaseLogger;
}): Promise<boolean> {
  const { zip, signal } = o;
  const bookFile = path.join(tmpdir(), `lume-export-${randomBytes(8).toString("hex")}.xlsx`);
  // The zip reads the workbook as it finishes; the file goes once the zip is done, however it ends.
  const cleanup = () => void rm(bookFile, { force: true });
  zip.once("end", cleanup).once("close", cleanup).once("error", cleanup);
  const c = await o.pool.connect();
  let held = true;
  const letGo = () => {
    if (held) c.release();
    held = false;
  };
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // A backstop: however it ends, this connection never sits in its transaction for long.
    await c.query("SET LOCAL idle_in_transaction_session_timeout = '10min'");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      o.userId,
    ]);
    const all = await tables(c);
    for (const t of all) {
      const out = new PassThrough();
      zip.append(out, { name: t.file });
      await write(out, csvLine(t.columns), signal);
      for await (const row of t.rows(c)) await write(out, csvLine(row), signal);
      out.end();
    }
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: bookFile,
      useStyles: false,
      useSharedStrings: false,
    });
    for (const t of all) {
      let part = 1;
      let n = 0;
      let sheet = book.addWorksheet(t.sheet);
      sheet.addRow(t.columns).commit();
      for await (const row of t.rows(c)) {
        signal.throwIfAborted();
        if (n === SHEET_ROWS) {
          sheet.commit();
          part++;
          n = 0;
          sheet = book.addWorksheet(`${t.sheet} (${part})`);
          sheet.addRow(t.columns).commit();
        }
        sheet.addRow(row.map(fitCell)).commit();
        n++;
      }
      sheet.commit();
    }
    await book.commit();
    await c.query("COMMIT");
    letGo();
    signal.throwIfAborted();
    zip.file(bookFile, { name: "LUME-export.xlsx" });
    await zip.finalize();
    return true;
  } catch (err) {
    if (held) await c.query("ROLLBACK").catch(() => undefined);
    if (!signal.aborted) o.log.error({ err }, "export failed");
    zip.abort();
    cleanup();
    return false;
  } finally {
    letGo();
  }
}

/** Export all data: a zip named for the day, in every licence state, audited. */
export async function exportAll(req: FastifyRequest, reply: FastifyReply, pool: pg.Pool) {
  await audit(req, { action: "data.export", entityType: "data" });
  const zip = archiver("zip", { zlib: { level: 6 } });
  const day = new Date().toISOString().slice(0, 10);
  void reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename="LUME-export-${day}.zip"`)
    .header("cache-control", "no-store");
  const ac = new AbortController();
  // A closed tab or a dropped connection: stop reading, and give the connection back.
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  void produceExport({ pool, userId: req.actor!.userId, zip, signal: ac.signal, log: req.log });
  return reply.send(zip);
}

/** A zip prepared for its download: kept until it's downloaded once, or for 10 minutes. */
type Prepared = { userId: string; file: string; name: string; expires: number };
const prepared = new Map<string, Prepared>();
const KEEP_MS = 10 * 60_000;
const forget = (id: string) => {
  const p = prepared.get(id);
  prepared.delete(id);
  if (p) void rm(p.file, { force: true });
};
function sweepPrepared(now = Date.now()) {
  for (const [id, p] of prepared) if (p.expires <= now) forget(id);
}
setInterval(sweepPrepared, 60_000).unref();

/**
 * Prepared exports an earlier run of the API left behind (it restarted before they expired): the whole
 * database, so they go at start rather than wait for the container to be recreated.
 */
export async function sweepLeftExports(dir = tmpdir(), now = Date.now()): Promise<void> {
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/^lume-export-[0-9a-f]+\.(zip|xlsx)$/.test(f)) continue;
    const at = path.join(dir, f);
    const s = await stat(at).catch(() => null);
    if (s && now - s.mtimeMs > KEEP_MS) await rm(at, { force: true });
  }
}

/**
 * Export all data, prepared (the screens' way): the zip is written to a private temporary file while the
 * screen ticks through the files, then the browser downloads it itself (GET /export/:id), so the page never
 * holds it in memory and a failure is said in LUME's words.
 */
export async function prepareExport(req: FastifyRequest, reply: FastifyReply, pool: pg.Pool) {
  sweepPrepared();
  await audit(req, { action: "data.export", entityType: "data" });
  const id = randomBytes(16).toString("hex");
  const file = path.join(tmpdir(), `lume-export-${id}.zip`);
  const name = `LUME-export-${new Date().toISOString().slice(0, 10)}.zip`;
  const zip = archiver("zip", { zlib: { level: 6 } });
  const ac = new AbortController();
  // The screen was closed before the zip was ready: stop, and leave nothing behind. The response's close
  // (not the request's: that fires once a body has been read, long before the answer).
  const onClose = () => {
    if (!reply.raw.writableFinished) ac.abort();
  };
  reply.raw.once("close", onClose);
  const written = pipeline(zip, createWriteStream(file, { mode: 0o600 }), { signal: ac.signal });
  let failed = false;
  // A failed read stops the write too (an aborted zip may never end on its own).
  const produced = produceExport({
    pool,
    userId: req.actor!.userId,
    zip,
    signal: ac.signal,
    log: req.log,
  }).then((whole) => {
    if (!whole && !ac.signal.aborted) {
      failed = true;
      ac.abort();
    }
  });
  try {
    await Promise.all([written, produced]);
    if (failed) throw new Error("the export stopped part way");
  } catch (err) {
    await rm(file, { force: true });
    if (ac.signal.aborted && !failed) return reply;
    req.log.error({ err }, "export failed");
    return reply.code(500).send({
      error: { code: "EXPORT_FAILED", message: "LUME couldn't finish the export. Try again." },
    });
  } finally {
    reply.raw.off("close", onClose);
  }
  prepared.set(id, { userId: req.actor!.userId, file, name, expires: Date.now() + KEEP_MS });
  return { id, name };
}

/**
 * The prepared zip, to the person who asked for it, as often as they need it until it expires (a cancelled
 * Save As, a second click); then it and its file are gone.
 */
export async function downloadPrepared(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const p = prepared.get(req.params.id);
  if (p && p.expires <= Date.now()) forget(req.params.id);
  if (!p || p.userId !== req.actor!.userId || p.expires <= Date.now())
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: "This export has gone. Export all data again." },
    });
  const body = createReadStream(p.file);
  return reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename="${p.name}"`)
    .header("cache-control", "no-store")
    .send(body);
}
