import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  INTAKE_LIMITS,
  can,
  type DateOrder,
  type Keyring,
  type LeadDraft,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { loadActor, type ActorRecord } from "../../rbac/actor";
import { loadMapContext, type FullMapContext } from "./context";
import { readImportFile } from "./files";
import { jobServer, withJobRequest } from "./job-request";
import { writeRow } from "./row";

const I = schema.imports;
const R = schema.importRows;
/** pg-boss retries a thrown run (the queues are created with retryLimit 5); the fifth failure is final. */
export const MAX_ATTEMPTS = 5;

export type RunHooks = {
  crashAfterRows?: number;
  beforeBatch?: (n: number) => Promise<void>;
  /** Tests: this row meets a real database error inside its own transaction. */
  breakRow?: number;
};
export type RunDeps = { app: FastifyInstance; pool: pg.Pool; keyring: Keyring; testHooks?: RunHooks };
type ImportRow = typeof I.$inferSelect;
type Db = ReturnType<typeof drizzle<typeof schema>>;
type ColumnSettings = { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };

/** What identifies a row's person, for spotting the same row again later (Sheets, spec §8). */
const fingerprint = (d: LeadDraft, cells: string[]) => {
  const identity = [d.leadCreatedAt ?? "", d.phone.e164 ?? "", d.email ?? "", d.instagram ?? ""];
  const basis = identity.some(Boolean) ? identity : cells.map((c) => c.trim());
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
};

/** Does this run give leads to people other than the person it runs as? Then it needs leads.assign too. */
export function givesAway(rules: Rules, mapping: Mapping, actor: ActorRecord): boolean {
  return (
    rules.owner.mode === "round_robin" ||
    (rules.owner.mode === "user" && rules.owner.userId !== actor.userId) ||
    mapping.columns.some((c) => c.to === "field" && c.field === "owner")
  );
}

/**
 * Spec §7.2: runs an import to the end, or until it's cancelled, loses access, or fails. Safe to call
 * again at any time: every row is claimed once, so a repeat carries on where the last attempt stopped.
 */
export async function runImport(o: RunDeps, importId: string): Promise<void> {
  o = { ...o, app: jobServer(o.app) };
  const db = drizzle(o.pool, { schema }); // the intake tables have no row-level security (amendment 5)
  const [claimed] = await db
    .update(I)
    .set({
      status: sql`CASE WHEN ${I.status} = 'cancelling' THEN ${I.status} ELSE 'running' END`,
      attempts: sql`${I.attempts} + 1`,
    })
    .where(sql`${I.id} = ${importId} AND ${I.status} IN ('queued', 'running', 'cancelling')`)
    .returning();
  if (!claimed) return; // cancelled, finished, or never started: nothing to do
  try {
    await runRows(o, db, claimed);
  } catch (e) {
    if (o.testHooks && String(e).includes("test crash")) throw e;
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    if (claimed.attempts < MAX_ATTEMPTS) throw e; // pg-boss retries, with backoff
    await db
      .update(I)
      .set({ status: "failed", stopReason: `failed: ${message}`, finishedAt: new Date() })
      .where(eq(I.id, importId));
    await auditAs(o, claimed.startedBy, "import.failed", importId, { message });
  }
}

/** An audit entry as the person who started the import (or with no actor, if they no longer exist). */
async function auditAs(o: RunDeps, userId: string | null, action: string, importId: string, diff: object) {
  const actor = userId ? await loadActor(o.pool, userId) : null;
  if (!actor) {
    await o.pool.query(
      "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff) VALUES ($1, $2, 'import', $3, $4)",
      [userId, action, importId, diff],
    );
    return;
  }
  await withJobRequest(
    { app: o.app, pool: o.pool, actor, requestId: `import:${importId}:${action}`, allLeads: false },
    (req) => audit(req, { action, entityType: "import", entityId: importId, diff: { ...diff } }),
  );
}

async function runRows(o: RunDeps, db: Db, imp: ImportRow) {
  const file = readImportFile(o.keyring, imp);
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  const columnSettings = imp.columnSettings as ColumnSettings;
  const startedBy = imp.startedBy!;
  const from = file.rowNumbers.findIndex((n) => n > imp.cursorRow);
  let committed = 0;

  for (
    let at = from === -1 ? file.rows.length : from, batch = 0;
    at < file.rows.length;
    at += INTAKE_LIMITS.batch, batch++
  ) {
    await o.testHooks?.beforeBatch?.(batch);
    const [now] = await db.select({ status: I.status }).from(I).where(eq(I.id, imp.id));
    if (now?.status === "cancelling") {
      await db
        .update(I)
        .set({ status: "cancelled", stopReason: "cancelled", finishedAt: new Date() })
        .where(eq(I.id, imp.id));
      return;
    }
    // Permissions, people and fields are read afresh before every batch (spec §7.3).
    const actor = await loadActor(o.pool, startedBy);
    if (
      !actor ||
      !can(actor, "leads.import") ||
      (givesAway(imp.rules as Rules, imp.mapping as Mapping, actor) && !can(actor, "leads.assign"))
    ) {
      await db
        .update(I)
        .set({ status: "stopped_access", stopReason: "access_changed", finishedAt: new Date() })
        .where(eq(I.id, imp.id));
      await auditAs(o, startedBy, "import.stopped", imp.id, { reason: "access_changed" });
      return;
    }
    const job = (suffix: string) => ({
      app: o.app,
      pool: o.pool,
      actor,
      requestId: `import:${imp.id}:${suffix}`,
      allLeads: true,
    });
    const ctx = await withJobRequest(job("context"), (req) =>
      loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, columnSettings }),
    );
    const end = Math.min(at + INTAKE_LIMITS.batch, file.rows.length);
    for (let i = at; i < end; i++) {
      const rowNumber = file.rowNumbers[i]!;
      try {
        await withJobRequest(job(String(rowNumber)), async (req) => {
          if (o.testHooks?.breakRow === rowNumber) await req.db.execute(sql`SELECT 1 / 0`);
          await oneRow(req, o.keyring, { imp, rules, mapping }, ctx, file.rows[i]!, rowNumber);
        });
      } catch (e) {
        // A row the database refuses (a value out of range, a broken constraint) is that row's problem:
        // its transaction rolled back, it's recorded as an error, and the rest of the file carries on.
        if (!isDataError(e)) throw e;
        await withJobRequest(job(`${rowNumber}:refused`), (req) => refuseRow(req, imp.id, rowNumber, e));
      }
      committed++;
      if (o.testHooks?.crashAfterRows !== undefined && committed >= o.testHooks.crashAfterRows)
        throw new Error("test crash");
    }
  }
  const [done] = await db
    .update(I)
    .set({ status: "done", finishedAt: new Date() })
    .where(sql`${I.id} = ${imp.id} AND ${I.status} IN ('running', 'cancelling')`)
    .returning({
      created: I.created,
      merged: I.merged,
      skipped: I.skipped,
      empty: I.empty,
      errors: I.errors,
    });
  if (done) await auditAs(o, startedBy, "import.finished", imp.id, done);
}

/** Postgres data exceptions (class 22) and integrity violations (class 23), however the driver wraps them. */
export function isDataError(e: unknown): boolean {
  const code =
    (e as { code?: unknown; cause?: { code?: unknown } })?.code ??
    (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && /^2[23]/.test(code);
}

/** Why the database refused a row, in a line short enough for a report. */
export const refusalReason = (e: unknown): string =>
  String((e as { cause?: { message?: unknown } })?.cause?.message ?? (e as Error)?.message ?? e).slice(
    0,
    200,
  );

async function refuseRow(req: FastifyRequest, importId: string, rowNumber: number, e: unknown) {
  const reason = refusalReason(e);
  const [row] = await req.db
    .insert(R)
    .values({
      importId,
      rowIndex: rowNumber,
      result: "error",
      problems: [
        { column: null, code: "ROW_NOT_SAVED", message: `LUME couldn't save this row (${reason}).` },
      ],
    })
    .onConflictDoNothing()
    .returning({ id: R.id });
  if (!row) return;
  await req.db.execute(
    sql`UPDATE imports SET errors = errors + 1, cursor_row = GREATEST(cursor_row, ${rowNumber}) WHERE id = ${importId}`,
  );
}

type Run = { imp: ImportRow; rules: Rules; mapping: Mapping };
/** Claim the row, write it through the shared engine (row.ts), record its result and the counts. */
async function oneRow(
  req: FastifyRequest,
  keyring: Keyring,
  run: Run,
  ctx: FullMapContext,
  cells: string[],
  rowNumber: number,
) {
  const { imp, rules, mapping } = run;
  const [claimed] = await req.db
    .insert(R)
    .values({
      importId: imp.id,
      rowIndex: rowNumber,
      result: "pending",
      rawEnc: keyring.encrypt(JSON.stringify(cells), `import-row:${imp.id}:${rowNumber}`),
    })
    .onConflictDoNothing()
    .returning({ id: R.id });
  if (!claimed) return; // an earlier attempt already finished this row

  const r = await writeRow(req, {
    sourceId: imp.sourceId,
    rules,
    mapping,
    ctx,
    cells,
    origin: { importId: imp.id, file: imp.fileName, row: rowNumber },
    nextTurn: async () => {
      const { rows } = await req.db.execute<{ n: number }>(
        sql`UPDATE imports SET rr_cursor = rr_cursor + 1 WHERE id = ${imp.id} RETURNING rr_cursor - 1 AS n`,
      );
      return Number(rows[0]!.n);
    },
  });
  await req.db
    .update(R)
    .set({
      result: r.result,
      leadId: r.leadId,
      problems: r.problems,
      warnings: r.warnings,
      alsoMatched: r.alsoMatched,
      // Only a row that became (or matched) a lead has a person to recognise again.
      fingerprint: r.draft && r.result !== "error" ? fingerprint(r.draft, cells) : null,
    })
    .where(eq(R.id, claimed.id));
  const sets = Object.entries(r.counters)
    .filter(([, n]) => n)
    .map(([k, n]) => sql`${sql.identifier(k)} = ${sql.identifier(k)} + ${n}`);
  await req.db.execute(
    sql`UPDATE imports SET ${sql.join([...sets, sql`cursor_row = GREATEST(cursor_row, ${rowNumber})`], sql`, `)} WHERE id = ${imp.id}`,
  );
}
