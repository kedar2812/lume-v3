import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  INTAKE_LIMITS,
  can,
  fold,
  nameHeaders,
  type DateOrder,
  type Keyring,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import { loadActor, type ActorRecord } from "../../rbac/actor";
import { createTag } from "../catalog/service";
import { loadMapContext, type FullMapContext } from "../imports/context";
import { jobServer, withJobRequest } from "../imports/job-request";
import { writeRow } from "../imports/row";
import { givesAway, isDataError, refusalReason } from "../imports/runner";
import { tagParts } from "../imports/start";
import { openConfig } from "./config";
import { GoogleError, columnRange, isTransient, rowsRange, type GoogleSheets } from "./google";
import { anchorHash, dateColumnOf, headerDrift, sheetFingerprint, toRows, type SheetRow } from "./grid";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const SR = schema.sourceRows;
const CHUNK = 5000;
const HOUR = 3_600_000;
const RETRY_LIMIT = 200;

export type SyncDeps = {
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
  google: GoogleSheets;
  maxRows: number;
  now?: () => Date;
  /** Tests only: called after each row is written (n counts from 1). */
  testHooks?: { afterRow?: (n: number) => Promise<void> };
};
/** The sheet was paused or removed mid-sync, or another sync took over: stop, and change nothing more. */
class Stopped extends Error {}
const CHECK_EVERY = 25;
type Source = typeof S.$inferSelect;
type Db = NodePgDatabase<typeof schema>;
type ColumnSettings = { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };
/** fillIn: this row is the one that made that lead minutes ago, finished since (final review, finding 6). */
type Todo = { row: SheetRow; fp: string; fillIn?: { leadId: string; replaces: number } };
/** How long after a row makes a lead a change to it counts as finishing it, not a new enquiry. */
const FILL_IN_MINUTES = 30;

export type AttentionCode =
  | "ACCESS_LOST"
  | "SHEET_GONE"
  | "TAB_GONE"
  | "COLUMNS_CHANGED"
  | "TOO_MANY_ROWS"
  | "RUN_AS_ACCESS"
  | "GOOGLE_SETUP";
/** Something only a person can fix: the sheet waits (needs attention) until they do. */
export class Attention extends Error {
  constructor(
    readonly code: AttentionCode,
    message: string,
  ) {
    super(message);
  }
}

/** Google's refusals, in LUME's words: no access and gone need a person; the rest pass through. */
async function ask<T>(google: GoogleSheets, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "access")
      throw new Attention(
        "ACCESS_LOST",
        `LUME can't open this sheet any more. Share it with ${google.email} as a Viewer, then press Test again.`,
      );
    if (e instanceof GoogleError && e.kind === "not_found")
      throw new Attention("SHEET_GONE", "This spreadsheet was deleted, or moved where LUME can't reach it.");
    if (e instanceof GoogleError && e.kind === "setup")
      throw new Attention(
        "GOOGLE_SETUP",
        `LUME's Google connection isn't set up right (Google said: ${e.message}). Tell the person who installed LUME.`,
      );
    throw e;
  }
}

/**
 * Rows `from`..`lastRow` of a tab, in chunks. Google leaves out trailing empty rows of each range, so every
 * chunk but the last is padded back to its full length: a row keeps its position across chunks. Trailing
 * blank rows are then dropped. More than `limit` rows is a problem only a person can fix.
 */
export async function readSheetRows(o: {
  google: GoogleSheets;
  spreadsheetId: string;
  tab: string;
  from: number;
  lastRow: number;
  limit: number;
}): Promise<string[][]> {
  const out: string[][] = [];
  for (let at = o.from; at <= o.lastRow; at += CHUNK) {
    const to = Math.min(at + CHUNK - 1, o.lastRow);
    const [chunk = []] = await ask(o.google, () =>
      o.google.values(o.spreadsheetId, [rowsRange(o.tab, at, to)]),
    );
    out.push(...chunk);
    if (to < o.lastRow) while (out.length < to - o.from + 1) out.push([]);
    if (out.filter((r) => r.length).length > o.limit) break;
  }
  while (out.length && !out.at(-1)!.length) out.pop();
  if (out.length > o.limit)
    throw new Attention(
      "TOO_MANY_ROWS",
      `This sheet has more than ${o.limit.toLocaleString("en")} rows. LUME reads up to ${o.limit.toLocaleString("en")}.`,
    );
  return out;
}

/**
 * Drive's modifiedTime. Drive answers 404 for a file that is only unshared (as real Google does), so a 404
 * asks Sheets, which tells the two apart: 403 (share it again) or 404 (gone).
 */
async function changedAt(google: GoogleSheets, spreadsheetId: string): Promise<string> {
  try {
    return await google.modifiedTime(spreadsheetId);
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "not_found") await google.spreadsheet(spreadsheetId);
    throw e;
  }
}

/** The person the sheet runs as (amendment A2), if they may still do what its rules do. */
async function runAsActor(o: SyncDeps, src: Source, rules: Rules, mapping: Mapping): Promise<ActorRecord> {
  const actor = src.runAs ? await loadActor(o.pool, src.runAs) : null;
  if (
    actor &&
    can(actor, "leads.import") &&
    (!givesAway(rules, mapping, actor) || can(actor, "leads.assign"))
  )
    return actor;
  const { rows } = src.runAs
    ? await o.pool.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [src.runAs])
    : { rows: [] };
  throw new Attention(
    "RUN_AS_ACCESS",
    `${rows[0]?.name ?? "The person who connected this sheet"} connected this sheet and can no longer add leads. Open the sheet's settings and save them to run it as you.`,
  );
}

/**
 * Spec §5.2: one sync, end to end. Safe to call twice: only the sync the source points at runs, and
 * every row is claimed once (source_rows_once), so a repeat after a crash carries on without doubles.
 */
export async function runSync(o: SyncDeps, syncId: string): Promise<void> {
  o = { ...o, app: jobServer(o.app) };
  const now = o.now ?? (() => new Date());
  const db = drizzle(o.pool, { schema });
  const [sync] = await db
    .update(SY)
    .set({ status: "running", startedAt: now() })
    .where(and(eq(SY.id, syncId), eq(SY.status, "queued")))
    .returning();
  if (!sync) return;
  const [src] = await db.select().from(S).where(eq(S.id, sync.sourceId));
  if (!src || src.currentSyncId !== syncId || src.status !== "active") {
    await db
      .update(SY)
      .set({ status: "failed", error: "stopped", finishedAt: now() })
      .where(eq(SY.id, syncId));
    // Let go of the lock if it's still ours, so Resume (or the next request) syncs at once.
    if (src?.currentSyncId === syncId)
      await db
        .update(S)
        .set({ currentSyncId: null, syncLockUntil: null })
        .where(and(eq(S.id, src.id), eq(S.currentSyncId, syncId)));
    return;
  }
  // Close the sync and free the source, but only while the source still points at this sync.
  const settle = (syncPatch: Partial<typeof SY.$inferInsert>, sourcePatch: Partial<typeof S.$inferInsert>) =>
    db.transaction(async (tx) => {
      await tx
        .update(SY)
        .set({ ...syncPatch, finishedAt: now() })
        .where(eq(SY.id, syncId));
      await tx
        .update(S)
        .set({ ...sourcePatch, currentSyncId: null, syncLockUntil: null })
        .where(and(eq(S.id, src.id), eq(S.currentSyncId, syncId)));
    });
  try {
    const patch = await syncSource(o, db, src, syncId, now);
    await settle(
      { status: "done" },
      {
        ...patch,
        lastSyncedAt: now(),
        nextSyncAt: new Date(now().getTime() + src.pollSeconds * 1000),
        failures: 0,
        lastError: null,
      },
    );
  } catch (e) {
    if (e instanceof Stopped) {
      // Paused or removed mid-way: what's written stays; the sheet is no longer this sync's to change.
      await db
        .update(SY)
        .set({ status: "failed", error: "stopped", finishedAt: now() })
        .where(eq(SY.id, syncId));
      return;
    }
    if (e instanceof Attention) {
      await settle(
        { status: "failed", error: e.code },
        { status: "needs_attention", attentionCode: e.code, lastError: e.message },
      );
      await db.insert(schema.auditLog).values({
        actorUserId: null,
        action: "sheet.needs_attention",
        entityType: "lead_source",
        entityId: src.id,
        diff: { code: e.code, name: src.name },
        requestId: `sheet:${syncId}`,
      });
      return;
    }
    // Anything else passes on its own or is a bug: the sheet stays active and tries again later, backing off.
    if (!isTransient(e)) o.app.log.error({ err: e, sourceId: src.id }, "sheet sync failed");
    const failures = src.failures + 1;
    const message = isTransient(e) ? "Couldn't reach Google." : "Something went wrong reading this sheet.";
    await settle(
      { status: "failed", error: message },
      {
        failures,
        lastError: message,
        nextSyncAt: new Date(now().getTime() + Math.min(src.pollSeconds * 1000 * 2 ** failures, HOUR)),
      },
    );
  }
}

async function syncSource(
  o: SyncDeps,
  db: Db,
  src: Source,
  syncId: string,
  now: () => Date,
): Promise<Partial<typeof S.$inferInsert>> {
  const cfg = openConfig(o.keyring, src.id, src.configEnc!);
  const mapping = src.mapping as Mapping;
  const rules = src.rules as Rules;
  const saved = src.headers;
  const width = saved.length;
  await runAsActor(o, src, rules, mapping);

  // 1. Changed? Drive's modifiedTime is cheap; the Sheets quota is kept for sheets that changed.
  const modified = await ask(o.google, () => changedAt(o.google, cfg.spreadsheetId));
  const configChanged = src.syncedConfigVersion !== src.configVersion;
  // A quiet sheet is still owed its hourly full read when it changed since the last one: an edit the
  // incremental read can't see (a gap filled in the middle) is found then (final review, finding 2).
  const hourly = !src.fullReadAt || now().getTime() - src.fullReadAt.getTime() > HOUR;
  const owed = hourly && src.fullReadModified !== modified;
  if (modified === src.lastModified && !configChanged && !src.baseline && src.rekeyThrough === null && !owed)
    return {};

  // 2. The tab, by id (a renamed tab is followed), and its header, first row and last row read.
  const meta = await ask(o.google, () => o.google.spreadsheet(cfg.spreadsheetId));
  const tab = meta.tabs.find((t) => t.sheetId === cfg.sheetId);
  if (!tab) throw new Attention("TAB_GONE", `The tab “${cfg.tabTitle}” is gone from the spreadsheet.`);
  const h = cfg.headerRow;
  const tailRow = h + src.rowsRead;
  const [headRaw = [], firstRaw = [], tailRaw = []] = await ask(o.google, () =>
    o.google.values(cfg.spreadsheetId, [
      rowsRange(tab.title, h, h),
      rowsRange(tab.title, h + 1, h + 1),
      rowsRange(tab.title, tailRow, tailRow),
    ]),
  );
  // Padded to the saved width first, so a blank header cell is named "Column E" here just as the draft named it.
  const headCells = [...(headRaw[0] ?? [])];
  while (headCells.length < width) headCells.push("");
  const header = nameHeaders(headCells);
  const drift = headerDrift(saved, header, mapping);
  const broken = drift.broken[0];
  if (broken)
    throw new Attention(
      "COLUMNS_CHANGED",
      broken.now
        ? `The column “${broken.was}” is now called “${broken.now}”. Open the sheet's columns to check them — LUME won't guess.`
        : `The column “${broken.was}” is gone from the sheet. Open the sheet's columns to check them — LUME won't guess.`,
    );
  const first = firstRaw[0] ?? [];
  const anchorNow = anchorHash(header.slice(0, width), first, src.rowsRead ? (tailRaw[0] ?? []) : undefined);
  const full =
    src.baseline || src.rekeyThrough !== null || !src.headHash || anchorNow !== src.headHash || hourly;

  // 3. Read everything under the header, or only what's past the last row read.
  const from = full ? h + 1 : tailRow + 1;
  const raw = await readSheetRows({
    google: o.google,
    spreadsheetId: cfg.spreadsheetId,
    tab: tab.title,
    from,
    lastRow: Math.max(tab.rowCount, from),
    limit: full ? o.maxRows : o.maxRows - src.rowsRead,
  });
  const rowsRead = (full ? 0 : src.rowsRead) + raw.length;
  const lastRaw = raw.length ? raw.at(-1)! : tailRaw[0];
  const patch = {
    lastModified: modified,
    rowsRead,
    headHash: anchorHash(header.slice(0, width), first, rowsRead ? (lastRaw ?? []) : undefined),
    fullReadAt: full ? now() : src.fullReadAt,
    fullReadModified: full ? modified : src.fullReadModified,
    rekeyThrough: null,
    syncedConfigVersion: src.configVersion,
    newColumns: drift.added,
    baseline: false,
  };
  const rows = toRows(raw, from, width);
  // The date column once more, as stored (unformatted), for recognising rows (final review, finding 7).
  const dateCol = dateColumnOf(mapping);
  if (dateCol !== null && raw.length) {
    const [stored = []] = await ask(o.google, () =>
      o.google.values(cfg.spreadsheetId, [columnRange(tab.title, dateCol, from, from + raw.length - 1)], {
        unformatted: true,
      }),
    );
    for (const r of rows) r.dateKey = stored[r.number - from]?.[0] ?? "";
  }

  // 4. What's known, and the problem rows to look at again (a full read sees them anyway).
  const known = new Map(
    (await db.select({ fp: SR.fingerprint, result: SR.result }).from(SR).where(eq(SR.sourceId, src.id))).map(
      (r) => [r.fp, r.result],
    ),
  );
  const openErrors = await db
    .select({ id: SR.id, fp: SR.fingerprint, rowNumber: SR.rowNumber })
    .from(SR)
    .where(and(eq(SR.sourceId, src.id), eq(SR.result, "error")))
    .orderBy(SR.rowNumber)
    .limit(RETRY_LIMIT);
  let candidates = rows;
  const superseded: number[] = [];
  if (!full && openErrors.length) {
    const again = await ask(o.google, () =>
      o.google.values(
        cfg.spreadsheetId,
        openErrors.map((e) => rowsRange(tab.title, e.rowNumber, e.rowNumber)),
      ),
    );
    const reread = again.flatMap((g, i) => toRows(g, openErrors[i]!.rowNumber, width));
    if (dateCol !== null && reread.length) {
      const stored = await ask(o.google, () =>
        o.google.values(
          cfg.spreadsheetId,
          reread.map((r) => columnRange(tab.title, dateCol, r.number, r.number)),
          { unformatted: true },
        ),
      );
      reread.forEach((r, i) => (r.dateKey = stored[i]?.[0]?.[0] ?? ""));
    }
    openErrors.forEach((e) => {
      const now = reread.find((r) => r.number === e.rowNumber);
      if (!now || sheetFingerprint(now.cells, mapping, now.dateKey) !== e.fp) superseded.push(e.id);
    });
    candidates = [...reread, ...rows];
  }

  // 5. Baseline ("only rows from now on", amendment A3): record what's there, create nothing.
  if (src.baseline) {
    for (const r of rows) {
      const fp = sheetFingerprint(r.cells, mapping, r.dateKey);
      await db
        .insert(SR)
        .values({
          sourceId: src.id,
          fingerprint: fp,
          result: "skipped",
          syncId,
          rowNumber: r.number,
          problems: [
            { column: null, code: "BEFORE_START", message: "Was in the sheet before it was connected." },
          ],
        })
        .onConflictDoNothing();
    }
    return patch;
  }

  // 6. What to write: new rows, and problem rows (fixed or under new rules). Same fingerprint twice in one
  // read is one enquiry.
  // After an edit that changed how rows are recognised, a row already read is recognised again by where it
  // is, and keeps its lead; only a row that was a problem is tried again (final review, finding 1).
  const before = new Map<number, { result: string; leadId: string | null }>();
  if (src.rekeyThrough !== null) {
    const { rows: old } = await db.execute<{
      row_number: number;
      result: string;
      lead_id: string | null;
    }>(sql`
      SELECT DISTINCT ON (row_number) row_number, result, lead_id FROM source_rows
      WHERE source_id = ${src.id} AND row_number <= ${src.rekeyThrough} AND result NOT IN ('superseded', 'dismissed')
      ORDER BY row_number, id DESC`);
    for (const o of old) before.set(o.row_number, { result: o.result, leadId: o.lead_id });
  }
  // A row still being typed when it was read (a name first, the phone a minute later): on a full read, a
  // new fingerprint where a lead was made minutes ago, whose old fingerprint is gone from the whole sheet,
  // is that same row finished — it fills in that lead instead of making a second one.
  const recent = new Map<number, { id: number; fp: string; leadId: string }>();
  if (full && candidates.length) {
    const { rows: made } = await db.execute<{
      id: string;
      row_number: number;
      fingerprint: string;
      lead_id: string;
    }>(sql`
      SELECT DISTINCT ON (row_number) id, row_number, fingerprint, lead_id FROM source_rows
      WHERE source_id = ${src.id} AND result = 'created' AND lead_id IS NOT NULL
        AND first_seen_at > now() - make_interval(mins => ${FILL_IN_MINUTES})
      ORDER BY row_number, id DESC`);
    const everywhere = new Set(candidates.map((r) => sheetFingerprint(r.cells, mapping, r.dateKey)));
    for (const m of made)
      if (!everywhere.has(m.fingerprint))
        recent.set(m.row_number, { id: Number(m.id), fp: m.fingerprint, leadId: m.lead_id });
  }
  const seen = new Set<string>();
  const todo: Todo[] = [];
  for (const r of candidates) {
    const fp = sheetFingerprint(r.cells, mapping, r.dateKey);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const was = known.get(fp);
    if (was === undefined && src.rekeyThrough !== null && r.number <= src.rekeyThrough) {
      const old = before.get(r.number);
      if (old?.result !== "error") {
        await db
          .insert(SR)
          .values({
            sourceId: src.id,
            fingerprint: fp,
            result: "skipped",
            leadId: old?.leadId ?? null,
            syncId,
            rowNumber: r.number,
            problems: [
              { column: null, code: "REKEYED", message: "Recognised again after the columns changed." },
            ],
          })
          .onConflictDoNothing();
        continue;
      }
    }
    const made = was === undefined ? recent.get(r.number) : undefined;
    if (made) todo.push({ row: r, fp, fillIn: { leadId: made.leadId, replaces: made.id } });
    else if (was === undefined || was === "error") todo.push({ row: r, fp });
  }
  await db.update(SY).set({ rowsTotal: todo.length }).where(eq(SY.id, syncId));

  const columnSettings = src.columnSettings as ColumnSettings;
  let written = 0;
  for (let i = 0; i < todo.length; i += INTAKE_LIMITS.batch) {
    const slice = todo.slice(i, i + INTAKE_LIMITS.batch);
    // Permissions, people and fields are read afresh before every batch, as an import does.
    const actor = await runAsActor(o, src, rules, mapping);
    const job = (suffix: string) => ({
      app: o.app,
      pool: o.pool,
      actor,
      requestId: `sheet:${syncId}:${suffix}`,
      allLeads: true,
    });
    if (mapping.createMissingTags)
      await withJobRequest(job("tags"), (req) =>
        createMissingTags(
          req,
          mapping,
          slice.map((t) => t.row.cells),
        ),
      );
    const ctx = await withJobRequest(job("context"), (req) =>
      loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: width, columnSettings }),
    );
    for (const t of slice) {
      // Every 25 rows: still ours? Extends the lock if so; Pause and Remove let go of it, and that stops us.
      if (written % CHECK_EVERY === 0) {
        const held = await db.execute(
          sql`UPDATE lead_sources SET sync_lock_until = now() + interval '15 minutes' WHERE id = ${src.id} AND current_sync_id = ${syncId} AND status IN ('active', 'needs_attention')`,
        );
        if (!held.rowCount) throw new Stopped();
      }
      try {
        await withJobRequest(job(String(t.row.number)), (req) =>
          oneRow(req, o.keyring, { src, rules, mapping, ctx, syncId }, t),
        );
      } catch (e) {
        // A row the database refuses is that row's problem; the rest of the sheet carries on.
        if (!isDataError(e)) throw e;
        await withJobRequest(job(`${t.row.number}:refused`), (req) =>
          refuseRow(req, o.keyring, src.id, syncId, t, refusalReason(e)),
        );
      }
      written++;
      await o.testHooks?.afterRow?.(written);
    }
  }

  // 7. Problems no longer in the sheet are closed.
  if (full)
    await db.execute(
      sql`UPDATE source_rows SET result = 'superseded', raw_enc = NULL WHERE source_id = ${src.id} AND result = 'error' AND NOT (fingerprint = ANY(string_to_array(${[...seen].join(",")}, ',')))`,
    );
  else if (superseded.length)
    await db.execute(
      sql`UPDATE source_rows SET result = 'superseded', raw_enc = NULL WHERE id = ANY(string_to_array(${superseded.join(",")}, ',')::bigint[]) AND result = 'error'`,
    );
  return patch;
}

type Run = { src: Source; rules: Rules; mapping: Mapping; ctx: FullMapContext; syncId: string };

/** Claim the row (new, or a problem being retried), write it with the shared engine, and count it. */
async function oneRow(req: FastifyRequest, keyring: Keyring, run: Run, t: Todo) {
  const { src, rules, mapping, ctx, syncId } = run;
  const claim = await req.db.execute<{ id: string }>(sql`
    INSERT INTO source_rows (source_id, fingerprint, result, sync_id, row_number)
    VALUES (${src.id}, ${t.fp}, 'pending', ${syncId}, ${t.row.number})
    ON CONFLICT ON CONSTRAINT source_rows_once DO UPDATE
      SET result = 'pending', sync_id = EXCLUDED.sync_id, row_number = EXCLUDED.row_number, last_tried_at = now()
      WHERE source_rows.result = 'error'
    RETURNING id`);
  const id = claim.rows[0]?.id;
  if (!id) return; // dealt with already (by an earlier attempt of this sync, or another)
  const r = await writeRow(req, {
    sourceId: src.id,
    rules,
    mapping,
    ctx,
    cells: t.row.cells,
    origin: { sourceId: src.id, sheet: src.name, row: t.row.number },
    ...(t.fillIn ? { mergeInto: { leadId: t.fillIn.leadId, activity: "sheet_row_updated" } } : {}),
    nextTurn: async () => {
      const { rows } = await req.db.execute<{ n: number }>(
        sql`UPDATE lead_sources SET rr_cursor = rr_cursor + 1 WHERE id = ${src.id} RETURNING rr_cursor - 1 AS n`,
      );
      return Number(rows[0]!.n);
    },
  });
  // A finished row keeps the standing of the lead it made ("created"), and isn't counted as a merge.
  const fillIn = !!t.fillIn && r.result === "merged";
  await req.db
    .update(SR)
    .set({
      result: fillIn ? "created" : r.result,
      leadId: r.leadId,
      problems: r.problems,
      warnings: r.warnings,
      // Only a problem row keeps its cells (for the download and the retry), sealed to this source.
      rawEnc:
        r.result === "error"
          ? keyring.encrypt(JSON.stringify(t.row.cells), `sheet-row:${src.id}:${t.fp}`)
          : null,
    })
    .where(eq(SR.id, Number(id)));
  // The row's first reading is replaced by this one: it was the same row, not a second enquiry.
  if (t.fillIn && r.result !== "error")
    await req.db.update(SR).set({ result: "superseded" }).where(eq(SR.id, t.fillIn.replaces));
  const column = r.result === "error" ? "errors" : r.result;
  await req.db.execute(
    fillIn
      ? sql`UPDATE source_syncs SET rows_read = rows_read + 1 WHERE id = ${syncId}`
      : sql`UPDATE source_syncs SET rows_read = rows_read + 1, ${sql.identifier(column)} = ${sql.identifier(column)} + 1 WHERE id = ${syncId}`,
  );
}

async function refuseRow(
  req: FastifyRequest,
  keyring: Keyring,
  sourceId: string,
  syncId: string,
  t: Todo,
  reason: string,
) {
  await req.db.execute(sql`
    INSERT INTO source_rows (source_id, fingerprint, result, sync_id, row_number, problems, raw_enc)
    VALUES (${sourceId}, ${t.fp}, 'error', ${syncId}, ${t.row.number},
      ${JSON.stringify([{ column: null, code: "ROW_NOT_SAVED", message: `LUME couldn't save this row (${reason}).` }])}::jsonb,
      ${keyring.encrypt(JSON.stringify(t.row.cells), `sheet-row:${sourceId}:${t.fp}`)})
    ON CONFLICT ON CONSTRAINT source_rows_once DO UPDATE
      SET result = 'error', problems = EXCLUDED.problems, raw_enc = EXCLUDED.raw_enc, last_tried_at = now()`);
  await req.db.execute(
    sql`UPDATE source_syncs SET rows_read = rows_read + 1, errors = errors + 1 WHERE id = ${syncId}`,
  );
}

/** A sheet chosen to create missing tags keeps doing so for new rows (spec §5.2, as 2A's Start does). */
async function createMissingTags(req: FastifyRequest, mapping: Mapping, rows: string[][]) {
  const have = new Set(
    (await req.db.select({ label: schema.tags.label }).from(schema.tags)).map((t) => fold(t.label)),
  );
  for (const c of mapping.columns.filter((x) => x.to === "field" && x.field === "tags"))
    for (const cells of rows)
      for (const part of tagParts(c, cells[c.column] ?? "")) {
        if (have.has(fold(part)) || part.length > 60) continue; // too long: that row is a problem row
        have.add(fold(part));
        await createTag(req, { label: part });
      }
}
