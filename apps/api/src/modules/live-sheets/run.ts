import { inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  can,
  cellText,
  liveSheetRuleSchema,
  planWrites,
  rowHash,
  ruleWords,
  tierAllows,
  type LiveSheetRule,
  type SheetCell,
  type WritePlan,
  type Written,
} from "@lume/core";
import { schema } from "@lume/db";

type LiveSheetPause = NonNullable<(typeof schema.liveSheets.$inferSelect)["pauseReason"]>;
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { isLocked } from "../../licence/enforce";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { adminIds, notify } from "../notifications/notify";
import { GoogleError, grantTokens } from "../sheets/google";
import { grantContext } from "./connect";
import { liveSheetsGoogle, type LiveSheetsGoogle, type MadeSheet } from "./google";
import { desiredRows, stillThere, type Desired } from "./rows";

/**
 * One run of a live sheet (spec 2026-11-14 §6): what belongs in it, compared with what LUME last wrote and with what
 * people did in Google since, and only the differences written. Every write finds rows by their tags, so a run cut
 * off anywhere is simply carried on by the next one. A sheet that can't run (its plan, the licence, its maker, or a
 * person paused it) still takes out the rows of leads deleted from LUME, whenever Google answers.
 */
export type RunResult = "done" | "failed" | "paused" | "skipped";
export type RunOptions = {
  app: FastifyInstance;
  d: AppDeps;
  sheetId: string;
  runId: string;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (written: number) => void;
};

type SheetRow = {
  id: string;
  name: string;
  preset: "meta" | "own";
  rule: unknown;
  columns: string[];
  header: string[];
  edits: "keep" | "replace";
  grant_id: string | null;
  written_name: string | null;
  spreadsheet_id: string | null;
  url: string | null;
  tab_id: number | null;
  runs_as: string;
  status: string;
  pause_reason: LiveSheetPause | null;
  lead_count: number;
  google_modified_at: string | null;
  poll_seconds: number;
  failures: number;
  created_at: Date;
};

const HOUR = 3_600_000;
/** A write this big shows the card's own bar (Updating). */
const UPDATING_FROM = 100;

/** Pauses in words, for the person told (the card says the same, with its fix). */
export const PAUSE_WORDS: Record<LiveSheetPause, string> = {
  google_disconnected:
    "LUME can't reach the Google account it writes with any more. Connect Google again to carry on.",
  sheet_gone:
    "LUME can no longer open the sheet in Google: it was deleted or moved to the bin. Make it again to carry on.",
  maker_gone:
    "The person it runs as can't export leads any more (or left). An admin can take it over to carry on.",
  tier: "Live sheets come with Pro. LUME keeps it as it is until the plan includes them again.",
  licence: "LUME's licence isn't active, so live sheets wait until it is.",
  paused_by_person: "Someone paused it. Resume it to carry on.",
};

async function tx<T>(pool: pg.Pool, sweep: boolean, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (sweep) await c.query("SELECT set_config('lume.live_sheets_sweep', 'on', true)");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const ping = (pool: pg.Pool, sheet: string, kind: "progress" | "status") =>
  pool
    .query("SELECT pg_notify('lume_live_sheets', $1)", [JSON.stringify({ sheet, kind })])
    .catch(() => undefined);

async function written(pool: pg.Pool, sheetId: string): Promise<Written[]> {
  const { rows } = await pool.query<{
    lead_id: string;
    hash: string;
    cells: SheetCell[];
    edited_cols: number[];
    removed_by_hand: boolean;
  }>("SELECT lead_id, hash, cells, edited_cols, removed_by_hand FROM live_sheet_rows WHERE sheet_id = $1", [
    sheetId,
  ]);
  return rows.map((r) => ({
    leadId: r.lead_id,
    hash: r.hash,
    cells: r.cells,
    editedCols: r.edited_cols,
    removedByHand: r.removed_by_hand,
  }));
}

/** Of these leads, the ones that still exist in LUME (any reach): the privacy pass, which only ever removes. */
async function existing(pool: pg.Pool, runsAs: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      runsAs,
    ]);
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
      [ids],
    );
    await c.query("COMMIT");
    return new Set(rows.map((r) => r.id));
  } finally {
    c.release();
  }
}

/** What LUME now knows it wrote: rows added and updated stored with their hashes, removed ones forgotten. */
async function remember(
  pool: pg.Pool,
  sheetId: string,
  plan: WritePlan,
  keep: boolean,
  was: Map<string, Written>,
) {
  const put = [
    ...plan.add.map((r) => ({ leadId: r.leadId, cells: r.cells, edited: [] as number[] })),
    ...plan.update.map((u) => ({
      leadId: u.leadId,
      cells: u.cells,
      edited: keep ? (was.get(u.leadId)?.editedCols ?? []) : [],
    })),
  ];
  for (let i = 0; i < put.length; i += 1000) {
    const chunk = put.slice(i, i + 1000);
    await pool.query(
      `INSERT INTO live_sheet_rows (sheet_id, lead_id, hash, cells, edited_cols, removed_by_hand, written_at)
       SELECT $1, x.lead_id, x.hash, x.cells, ARRAY(SELECT jsonb_array_elements_text(x.edited)::int), false, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(lead_id uuid, hash text, cells jsonb, edited jsonb)
       ON CONFLICT (sheet_id, lead_id) DO UPDATE
         SET hash = EXCLUDED.hash, cells = EXCLUDED.cells, edited_cols = EXCLUDED.edited_cols,
             removed_by_hand = false, written_at = now()`,
      [
        sheetId,
        JSON.stringify(
          chunk.map((p) => ({ lead_id: p.leadId, hash: rowHash(p.cells), cells: p.cells, edited: p.edited })),
        ),
      ],
    );
  }
  if (plan.remove.length)
    await pool.query("DELETE FROM live_sheet_rows WHERE sheet_id = $1 AND lead_id = ANY($2::uuid[])", [
      sheetId,
      plan.remove,
    ]);
}

/** What people did in Google since LUME's last write: cells edited and rows deleted, kept for the next runs too. */
async function handEdits(
  pool: pg.Pool,
  google: LiveSheetsGoogle,
  s: MadeSheet,
  sheetId: string,
  was: Written[],
  width: number,
): Promise<Written[]> {
  const tab = await google.readTab(s);
  const byLead = new Map(tab.rows.filter((r) => r.leadId).map((r) => [r.leadId!, r.cells]));
  const out: Written[] = [];
  const changed: { lead_id: string; edited: number[]; removed: boolean }[] = [];
  for (const w of was) {
    if (w.removedByHand) {
      out.push(w);
      continue;
    }
    const now = byLead.get(w.leadId);
    if (!now) {
      out.push({ ...w, removedByHand: true });
      changed.push({ lead_id: w.leadId, edited: w.editedCols, removed: true });
      continue;
    }
    const edited = new Set(w.editedCols);
    for (let i = 0; i < width; i++) if ((now[i] ?? "") !== cellText(w.cells[i] ?? null)) edited.add(i);
    const list = [...edited].sort((a, b) => a - b);
    if (list.length !== w.editedCols.length)
      changed.push({ lead_id: w.leadId, edited: list, removed: false });
    out.push({ ...w, editedCols: list });
  }
  if (changed.length)
    await pool.query(
      `UPDATE live_sheet_rows r SET edited_cols = ARRAY(SELECT jsonb_array_elements_text(x.edited)::int),
              removed_by_hand = x.removed
         FROM jsonb_to_recordset($2::jsonb) AS x(lead_id uuid, edited jsonb, removed boolean)
        WHERE r.sheet_id = $1 AND r.lead_id = x.lead_id`,
      [sheetId, JSON.stringify(changed)],
    );
  return out;
}

export async function runLiveSheet(o: RunOptions): Promise<RunResult> {
  const pool = o.d.pool;
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (
      await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
        `live-sheet:${o.sheetId}`,
      ])
    ).rows[0]!.ok;
    const claimed = await pool.query<{ trigger: string }>(
      `UPDATE live_sheet_runs SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'queued' RETURNING trigger`,
      [o.runId],
    );
    if (!locked || !claimed.rowCount) {
      // Another run of this sheet holds it: this one has nothing left to do.
      if (claimed.rowCount)
        await pool.query("UPDATE live_sheet_runs SET status = 'done', finished_at = now() WHERE id = $1", [
          o.runId,
        ]);
      return "skipped";
    }
    return await runClaimed(o, claimed.rows[0]!.trigger);
  } finally {
    if (locked)
      await lock
        .query("SELECT pg_advisory_unlock(hashtext($1))", [`live-sheet:${o.sheetId}`])
        .catch(() => undefined);
    lock.release();
  }
}

async function runClaimed(o: RunOptions, trigger: string): Promise<RunResult> {
  const { app, d } = o;
  const pool = d.pool;
  const finish = (status: "done" | "failed", error: string | null = null) =>
    pool.query("UPDATE live_sheet_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1", [
      o.runId,
      status,
      error,
    ]);
  const loaded = await tx(pool, true, async (c) => {
    const s = (
      await c.query<SheetRow>("SELECT * FROM live_sheets WHERE id = $1 AND deleted_at IS NULL", [o.sheetId])
    ).rows[0];
    if (!s) return null;
    const g = s.grant_id
      ? (
          await c.query<{ grant_enc: Buffer; user_id: string }>(
            "SELECT grant_enc, user_id FROM live_sheet_grants WHERE id = $1",
            [s.grant_id],
          )
        ).rows[0]
      : undefined;
    return { s, g };
  });
  if (!loaded) {
    await finish("done");
    return "skipped";
  }
  const sheet = loaded.s;
  const now = d.clock();

  const pause = async (reason: LiveSheetPause) => {
    const was = sheet.status === "paused" && sheet.pause_reason === reason;
    await pool.query(
      "UPDATE live_sheets SET status = 'paused', pause_reason = $2, next_sync_at = $3, updated_at = now() WHERE id = $1",
      [sheet.id, reason, new Date(now.getTime() + sheet.poll_seconds * 1000)],
    );
    if (!was) {
      const who = new Set([sheet.runs_as, ...(reason === "maker_gone" ? await adminIds(pool) : [])]);
      for (const u of who)
        await notify(pool, u, {
          kind: "system_alert",
          title: `“${sheet.name}” is paused`,
          body: PAUSE_WORDS[reason],
        }).catch(() => undefined);
    }
    await ping(pool, sheet.id, "status");
    await finish("done");
    return "paused" as const;
  };

  if (!loaded.g || !d.googleOAuth) return pause("google_disconnected");
  const tokens = grantTokens(
    d.googleOAuth,
    d.keyring.decrypt(loaded.g.grant_enc, grantContext(sheet.grant_id!)),
  );
  const google = liveSheetsGoogle({
    tokens,
    ...(d.googleEndpoint ? { endpoint: d.googleEndpoint } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  const made: MadeSheet | null =
    sheet.spreadsheet_id && sheet.tab_id !== null
      ? { spreadsheetId: sheet.spreadsheet_id, url: sheet.url ?? "", tabId: sheet.tab_id }
      : null;

  const backOff = async (e: unknown) => {
    const failures = sheet.failures + 1;
    const wait = Math.min(sheet.poll_seconds * 1000 * 2 ** failures, HOUR);
    const words =
      e instanceof GoogleError && e.kind === "setup"
        ? "LUME's Google connection needs fixing on this server."
        : "Google is slow right now; LUME will keep going.";
    await pool.query(
      "UPDATE live_sheets SET failures = $2, next_sync_at = $3, last_error = $4, status = CASE WHEN status IN ('making', 'paused') THEN status ELSE 'live' END, updated_at = now() WHERE id = $1",
      [sheet.id, failures, new Date(now.getTime() + wait), words],
    );
    if (!(e instanceof GoogleError)) app.log.error({ err: e, sheet: sheet.id }, "live sheet run failed");
    await ping(pool, sheet.id, "status");
    await finish("failed", words);
    return "failed" as const;
  };

  try {
    // Google first: a grant taken away is said as that, not as a missing sheet.
    try {
      await tokens();
    } catch (e) {
      if (e instanceof GoogleError && e.kind === "access") return await pause("google_disconnected");
      throw e;
    }
    if (made) {
      const f = await google.file(made.spreadsheetId);
      if (f.trashed) return await pause("sheet_gone");
    }

    // What stops a full run; a privacy pass still runs.
    const plan = app.licence.view();
    const actor = await loadActor(pool, sheet.runs_as);
    const reason: LiveSheetPause | null =
      sheet.pause_reason === "paused_by_person"
        ? "paused_by_person"
        : isLocked(plan.state)
          ? "licence"
          : !tierAllows(plan.plan, "live_sheets")
            ? "tier"
            : !actor || !can(actor, "leads.live_sheets") || !can(actor, "leads.export")
              ? "maker_gone"
              : null;
    if (reason) {
      if (made) {
        const was = await written(pool, sheet.id);
        const there = await existing(
          pool,
          sheet.runs_as,
          was.filter((w) => !w.removedByHand).map((w) => w.leadId),
        );
        const gone = was.filter((w) => !w.removedByHand && !there.has(w.leadId)).map((w) => w.leadId);
        if (gone.length) {
          const p: WritePlan = { add: [], update: [], remove: gone };
          await google.write(made, p, async () => {});
          await remember(pool, sheet.id, p, false, new Map());
          await pool.query(
            "UPDATE live_sheets SET lead_count = (SELECT count(*) FROM live_sheet_rows WHERE sheet_id = $1 AND NOT removed_by_hand) WHERE id = $1",
            [sheet.id],
          );
        }
      }
      return await pause(reason);
    }

    const rule = liveSheetRuleSchema.parse(sheet.rule) as LiveSheetRule;
    const spec = { preset: sheet.preset, rule, columns: sheet.columns, createdAt: sheet.created_at };
    const was = await written(pool, sheet.id);
    const read = await withJobRequest(
      { app: jobServer(app), pool, actor: actor!, requestId: `live-sheet:${o.runId}`, allLeads: false },
      async (req) => {
        const desired = await desiredRows(req, spec);
        const there = await stillThere(
          req,
          was.map((w) => w.leadId),
        );
        const names = await namesFor(req, rule);
        return { desired, there, names };
      },
    );
    const desired: Desired = read.desired;
    if (desired.hasContacts && !desired.contactsFull) return await pause("maker_gone");

    let s = made;
    if (!s) {
      s = await google.create({
        title: sheet.name,
        header: desired.header,
        about: { markUrl: markUrl(d), lines: aboutLines(rule, read.names, 0, now, await tzOf(pool)) },
      });
      await pool.query(
        "UPDATE live_sheets SET spreadsheet_id = $2, url = $3, tab_id = $4, header = $5, written_name = $6, updated_at = now() WHERE id = $1",
        [sheet.id, s.spreadsheetId, s.url, s.tabId, JSON.stringify(desired.header), sheet.name],
      );
      sheet.header = desired.header;
      sheet.written_name = sheet.name;
      await ping(pool, sheet.id, "status");
    }

    // Renamed in LUME: the file and its first tab follow.
    if (sheet.written_name !== sheet.name) {
      await google.rename(s, sheet.name);
      await pool.query("UPDATE live_sheets SET written_name = $2 WHERE id = $1", [sheet.id, sheet.name]);
    }
    let rows = was;
    const headerChanged = JSON.stringify(sheet.header) !== JSON.stringify(desired.header);
    if (headerChanged) {
      await google.setHeader(s, desired.header);
      // Columns moved: what a person edited before can't be told apart any more.
      await pool.query("UPDATE live_sheet_rows SET edited_cols = '{}' WHERE sheet_id = $1", [sheet.id]);
      rows = rows.map((w) => ({ ...w, editedCols: [] }));
    }
    // Only read the sheet back when someone changed it since LUME's last write.
    if (made && rows.length) {
      const f = await google.file(s.spreadsheetId);
      if (f.modifiedTime !== sheet.google_modified_at)
        rows = await handEdits(pool, google, s, sheet.id, rows, desired.header.length);
    }
    const deleted = new Set(rows.map((w) => w.leadId).filter((id) => !read.there.has(id)));
    const writes = planWrites({
      desired: desired.rows,
      written: rows,
      edits: sheet.edits,
      ruleMode: rule.stages.mode,
      deleted,
    });
    const total = writes.add.length + writes.update.length + writes.remove.length;
    await pool.query("UPDATE live_sheet_runs SET total = $2 WHERE id = $1", [o.runId, total]);
    if (total >= UPDATING_FROM)
      await pool.query("UPDATE live_sheets SET status = 'updating' WHERE id = $1 AND status NOT IN ('making', 'paused')", [
        sheet.id,
      ]);
    await ping(pool, sheet.id, "progress");
    let shown = 0;
    if (total)
      await google.write(s, writes, async (done) => {
        // The count only rises: a step Google answered twice never shows fewer.
        shown = Math.max(shown, done);
        await pool.query("UPDATE live_sheet_runs SET written = $2 WHERE id = $1", [o.runId, shown]);
        o.onProgress?.(shown);
        await ping(pool, sheet.id, "progress");
      });
    await remember(pool, sheet.id, writes, sheet.edits === "keep", new Map(rows.map((w) => [w.leadId, w])));
    const count = Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM live_sheet_rows WHERE sheet_id = $1 AND NOT removed_by_hand",
          [sheet.id],
        )
      ).rows[0]!.n,
    );
    if (total || count !== sheet.lead_count || !made)
      await google.setAbout(s, aboutLines(rule, read.names, count, now, await tzOf(pool)));
    const after = await google.file(s.spreadsheetId);
    await pool.query(
      `UPDATE live_sheets SET lead_count = $2,
              -- Paused by a person while this run wrote: their pause stands.
              status = CASE WHEN pause_reason = 'paused_by_person' THEN 'paused' ELSE 'live' END,
              pause_reason = CASE WHEN pause_reason = 'paused_by_person' THEN pause_reason END, capped = $3, header = $4,
              last_synced_at = $5, next_sync_at = $6, failures = 0, last_error = NULL, google_modified_at = $7,
              updated_at = now()
        WHERE id = $1`,
      [
        sheet.id,
        count,
        desired.capped,
        JSON.stringify(desired.header),
        now,
        new Date(now.getTime() + sheet.poll_seconds * 1000),
        after.modifiedTime,
      ],
    );
    await pool.query("UPDATE live_sheet_runs SET written = $2 WHERE id = $1", [o.runId, total]);
    if (trigger === "make")
      await withJobRequest(
        { app: jobServer(app), pool, actor: actor!, requestId: `live-sheet:${o.runId}`, allLeads: false },
        (req) =>
          audit(req, {
            action: "live_sheet.filled",
            entityType: "live_sheet",
            entityId: sheet.id,
            diff: { name: sheet.name, rows: count },
          }),
      );
    await ping(pool, sheet.id, "status");
    await finish("done");
    return "done";
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "not_found") return pause("sheet_gone");
    if (e instanceof GoogleError && e.kind === "access") {
      // A refused call is either the grant taken away (a fresh token is refused too) or the file out of reach.
      try {
        await tokens(true);
      } catch (again) {
        if (again instanceof GoogleError && again.kind === "access") return pause("google_disconnected");
      }
      return pause("sheet_gone");
    }
    return backOff(e);
  }
}

type Names = Parameters<typeof ruleWords>[1];

async function namesFor(req: FastifyRequest, rule: LiveSheetRule): Promise<Names> {
  const S = schema;
  const of = async (
    ids: string[] | undefined,
    read: (ids: string[]) => Promise<{ id: string; n: string }[]>,
  ) => new Map((ids?.length ? await read(ids) : []).map((x) => [x.id, String(x.n)]));
  const [stages, sources, tags, people, teams] = await Promise.all([
    of(rule.stages.stageIds, (ids) =>
      req.db.select({ id: S.stages.id, n: S.stages.name }).from(S.stages).where(inArray(S.stages.id, ids)),
    ),
    of(rule.sourceIds, (ids) =>
      req.db
        .select({ id: S.leadSources.id, n: S.leadSources.name })
        .from(S.leadSources)
        .where(inArray(S.leadSources.id, ids)),
    ),
    of(rule.tagIds, (ids) =>
      req.db.select({ id: S.tags.id, n: S.tags.label }).from(S.tags).where(inArray(S.tags.id, ids)),
    ),
    of(rule.ownerIds, (ids) =>
      req.db.select({ id: S.users.id, n: S.users.name }).from(S.users).where(inArray(S.users.id, ids)),
    ),
    of(rule.teamIds, (ids) =>
      req.db.select({ id: S.teams.id, n: S.teams.name }).from(S.teams).where(inArray(S.teams.id, ids)),
    ),
  ]);
  const pick = (m: Map<string, string>, fallback: string) => (id: string) => m.get(id) ?? fallback;
  return {
    stage: pick(stages, "a stage"),
    source: pick(sources, "a source"),
    tag: pick(tags, "a tag"),
    person: pick(people, "someone"),
    team: pick(teams, "a team"),
  };
}

async function tzOf(pool: pg.Pool): Promise<string> {
  const r = await pool.query<{ timezone: string }>("SELECT timezone FROM settings WHERE id = 1");
  return r.rows[0]?.timezone ?? "UTC";
}

/** Where Google fetches LUME's mark from: this LUME's own address, the official file as it is. */
export const markUrl = (d: AppDeps) => `${d.config.publicUrl.replace(/\/$/, "")}/lume-mark.png`;

export function aboutLines(
  rule: LiveSheetRule,
  names: Names,
  count: number,
  now: Date,
  tz: string,
): string[] {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return [
    "Kept up to date by LUME · lumecrm.in",
    ruleWords(rule, names),
    `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`,
    `Last updated ${when}`,
  ];
}
