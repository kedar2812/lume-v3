import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { FastifyRequest } from "fastify";
import { deviceName, normaliseCode, readCsv } from "@lume/core";
import { audit } from "../../audit/audit";
import { HttpError, badRequest } from "../../http/errors";
import { zipFits } from "./zip-guard";

const UNREADABLE = () =>
  new HttpError(400, "UNREADABLE", "LUME can't read this file. Give it a CSV or Excel file.");
const REF = /^lume\s*ref$/i;
/** A check row's email, exactly as LUME makes it (checkRow in @lume/core): never a whole cell taken on trust. */
const CHECK_EMAIL = /[a-z]+\.[a-z]+\.[0-9a-f]{6}@example\.invalid/gi;
/** Every row of an export, and then some: a CSV can hold more than an import takes (6B review). */
const MAX_ROWS = 200_000;

/** What an Excel file may open to before LUME refuses it unread (6B review): 50 MB, many times a full export. */
const DEFAULT_INFLATE_CAP = 50 * 1024 * 1024;
let inflateCap = DEFAULT_INFLATE_CAP;
/** Tests only: a smaller ceiling, or null for the default. */
export function setTraceInflateCapForTests(n: number | null): void {
  inflateCap = n ?? DEFAULT_INFLATE_CAP;
}

/** A list of values for `= ANY(...)`, each its own bound parameter. */
const list = (xs: string[]) =>
  sql`ARRAY[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`;

/** The file's cells as text: Excel's first sheet, or a CSV however it's written. Read in memory, never kept. */
async function cellsOf(bytes: Buffer, fileName: string): Promise<string[][]> {
  // An .xlsx file is a zip: it starts "PK\x03\x04".
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const fits = zipFits(bytes, inflateCap);
    if (fits === "big")
      throw new HttpError(
        400,
        "TOO_BIG",
        "This Excel file opens to more than LUME reads at once. Save it as CSV.",
      );
    if (fits === "bad") throw UNREADABLE();
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw UNREADABLE();
    }
    const sheet = book.worksheets[0];
    if (!sheet) throw UNREADABLE();
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(c.text ?? ""));
      rows.push(cells);
    });
    return rows;
  }
  const r = readCsv(new Uint8Array(bytes), { fileName, allowNoRows: true, maxRows: MAX_ROWS });
  if (!r.ok) throw UNREADABLE();
  return [r.headers, ...r.rows];
}

type Found = { id: string; foundBy: "column" | "check_row" };

/** Codes in a "LUME ref" column, in the order they appear: the first one LUME made wins. */
async function byColumn(req: FastifyRequest, rows: string[][]): Promise<Found | null> {
  for (let h = 0; h < Math.min(rows.length, 5); h++) {
    const col = rows[h]!.findIndex((c) => REF.test(c.trim()));
    if (col < 0) continue;
    const codes = [
      ...new Set(
        rows
          .slice(h + 1)
          .map((r) => normaliseCode(r[col] ?? ""))
          .filter((c) => c !== null),
      ),
    ];
    if (!codes.length) return null;
    const { rows: hits } = await req.db.execute(sql`
      SELECT id, code FROM lead_exports WHERE code = ANY(${list(codes)})`);
    const byCode = new Map((hits as { id: string; code: string }[]).map((x) => [x.code, x.id]));
    const first = codes.find((c) => byCode.has(c));
    return first ? { id: byCode.get(first)!, foundBy: "column" } : null;
  }
  return null;
}

/**
 * A check row anywhere in the file: its email, or its phone when that number names a single export (the fiction
 * range has only 1,000 numbers; plan ruling B3). The column may be gone and the rows re-sorted.
 */
async function byCheckRow(req: FastifyRequest, rows: string[][]): Promise<Found | null> {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of rows)
    for (const cell of row) {
      for (const m of cell.matchAll(CHECK_EMAIL)) emails.add(m[0].toLowerCase());
      const digits = cell.replace(/\D/g, "");
      if (/^447700900\d{3}$/.test(digits)) phones.add(digits);
    }
  if (emails.size) {
    const { rows: hit } = await req.db.execute(sql`
      SELECT id FROM lead_exports WHERE lower(check_email) = ANY(${list([...emails])})
       ORDER BY created_at LIMIT 1`);
    if (hit[0]) return { id: (hit[0] as { id: string }).id, foundBy: "check_row" };
  }
  if (phones.size) {
    const { rows: hit } = await req.db.execute(sql`
      SELECT min(id::text) AS id FROM lead_exports
       WHERE regexp_replace(check_phone, '\\D', '', 'g') = ANY(${list([...phones])})
       GROUP BY regexp_replace(check_phone, '\\D', '', 'g') HAVING count(*) = 1
       ORDER BY 1 LIMIT 1`);
    if (hit[0]) return { id: (hit[0] as { id: string }).id, foundBy: "check_row" };
  }
  return null;
}

/** Who, when, what, and every download (with the device), for the answer. */
async function describe(req: FastifyRequest, f: Found) {
  const { rows } = await req.db.execute(sql`
    SELECT e.code, e.label, e.format, e.row_count, e.created_at, u.id AS user_id, u.name
      FROM lead_exports e JOIN users u ON u.id = e.user_id WHERE e.id = ${f.id}`);
  const e = rows[0] as {
    code: string;
    label: string;
    format: "csv" | "xlsx";
    row_count: number;
    created_at: Date | string;
    user_id: string;
    name: string;
  };
  const { rows: dl } = await req.db.execute(sql`
    SELECT at, diff->>'device' AS device FROM audit_log
     WHERE action = 'lead.export.download' AND entity_id = ${f.id} ORDER BY at`);
  return {
    id: f.id,
    code: e.code,
    who: { id: e.user_id, name: e.name },
    createdAt: new Date(e.created_at).toISOString(),
    label: e.label,
    rows: e.row_count,
    format: e.format,
    foundBy: f.foundBy,
    downloads: (dl as { at: Date | string; device: string | null }[]).map((d) => ({
      at: new Date(d.at).toISOString(),
      device: deviceName(d.device),
    })),
  };
}

export type TraceMatch = Awaited<ReturnType<typeof describe>>;

/**
 * Trace a file found outside the business (spec §3), or a code typed from its LUME ref column. The file is read
 * in memory and forgotten; only the answer is audited ("found: <code>" or null), never the file.
 */
export async function trace(
  req: FastifyRequest,
  input: { file: Buffer; fileName: string } | { code: string },
): Promise<{ match: TraceMatch | null }> {
  let found: Found | null = null;
  if ("code" in input) {
    const code = normaliseCode(input.code);
    if (!code) throw badRequest("BAD_CODE", "That isn't a LUME ref code. It looks like LX7Q-4MRA.");
    const { rows } = await req.db.execute(sql`SELECT id FROM lead_exports WHERE code = ${code}`);
    if (rows[0]) found = { id: (rows[0] as { id: string }).id, foundBy: "column" };
  } else {
    const rows = await cellsOf(input.file, input.fileName);
    found = (await byColumn(req, rows)) ?? (await byCheckRow(req, rows));
  }
  const match = found ? await describe(req, found) : null;
  await audit(req, {
    action: "security.trace",
    entityType: "lead_export",
    entityId: match?.id ?? null,
    diff: { found: match?.code ?? null },
  });
  return { match };
}
