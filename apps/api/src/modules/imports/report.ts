import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import Papa from "papaparse";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { getImport } from "./service";

const R = schema.importRows;
const PAGE = 100;
// A cell a spreadsheet would run as a formula gets a leading apostrophe (CSV injection).
const FORMULA = /^[=+\-@\t\r]/;
const safeCell = (v: string) => (FORMULA.test(v) ? `'${v}` : v);

/** Row detail is for whoever ran the import, or someone who could see every lead's full contact anyway. */
async function rowsAllowed(req: FastifyRequest, id: string) {
  const v = await getImport(req, id);
  if (!v.canSeeRows)
    throw new HttpError(
      403,
      "ROWS_HIDDEN",
      "Only the person who ran this import, or someone who can see every lead's contact details, can see its rows.",
    );
  return v;
}

const cellsOf = (d: AppDeps, id: string, r: typeof R.$inferSelect): string[] | null =>
  r.rawEnc ? (JSON.parse(d.keyring.decrypt(r.rawEnc, `import-row:${id}:${r.rowIndex}`)) as string[]) : null;

export async function listRows(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  q: { result?: "created" | "merged" | "skipped" | "error"; cursor?: number },
) {
  await rowsAllowed(req, id);
  const rows = await req.db
    .select()
    .from(R)
    .where(
      and(
        eq(R.importId, id),
        q.result ? eq(R.result, q.result) : undefined,
        q.cursor !== undefined ? gt(R.rowIndex, q.cursor) : undefined,
      ),
    )
    .orderBy(asc(R.rowIndex))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const leadIds = [...new Set(page.map((r) => r.leadId).filter((x): x is string => !!x))];
  // The caller's own row-level security decides which leads they may see named.
  const visible = new Map(
    leadIds.length
      ? (
          await req.db
            .select({ id: schema.leads.id, name: schema.leads.name })
            .from(schema.leads)
            .where(inArray(schema.leads.id, leadIds))
        ).map((l) => [l.id, l.name])
      : [],
  );
  return {
    rows: page.map((r) => ({
      rowNumber: r.rowIndex,
      result: r.result,
      problems: r.problems,
      warnings: r.warnings,
      lead: r.leadId
        ? visible.has(r.leadId)
          ? { visible: true as const, id: r.leadId, name: visible.get(r.leadId)! }
          : { visible: false as const }
        : null,
      cells: cellsOf(d, id, r),
    })),
    nextCursor: rows.length > PAGE ? page.at(-1)!.rowIndex : null,
  };
}

/** The rows that failed, with why, as a CSV that opens cleanly in Excel (BOM, CRLF, no live formulas). */
export async function errorsCsv(req: FastifyRequest, d: AppDeps, id: string) {
  const v = await rowsAllowed(req, id);
  const [imp] = await req.db
    .select({ headers: schema.imports.headers })
    .from(schema.imports)
    .where(eq(schema.imports.id, id));
  const rows = await req.db
    .select()
    .from(R)
    .where(and(eq(R.importId, id), eq(R.result, "error")))
    .orderBy(asc(R.rowIndex));
  const data = rows.map((r) =>
    [r.problems.map((p) => p.message).join(" "), ...(cellsOf(d, id, r) ?? [])].map((c) => safeCell(c ?? "")),
  );
  const table = Papa.unparse([["Problem", ...imp!.headers], ...data], { newline: "\r\n" });
  return {
    fileName: `${v.fileName.replace(/\.[^.]+$/, "")}-problems.csv`,
    body: `${String.fromCharCode(0xfeff)}${table}\r\n`,
  };
}
