import type pg from "pg";
import { CLEAN_KINDS, OLD_FILE_MONTHS, PREVIEW_IDLE_DAYS, type CleanKind } from "@lume/core";
import type { FilesDeps } from "../whatsapp/files";

/**
 * What LUME keeps on the disk, and what each clean-up would give back (plan 2026-11-23-storage-clean-up, Task 1).
 *
 * Every file is one row of whatsapp_files (its bytes once on disk, however many messages point at it) with `refs`,
 * the count a trigger keeps of what points at it: chat files (WhatsApp, Instagram), profile photos, library files,
 * previews. A clean-up clears references; a file's bytes come back only when every reference to it is cleared, so a
 * candidate counts a file's bytes only when all of its `refs` are in that candidate. A file another lead still holds
 * counts nothing and is never deleted.
 */

/** One table a clean-up clears rows of: which, how its rows are chosen, which of its columns point at files. */
export type Part = {
  table: "whatsapp_media" | "instagram_media" | "file_previews" | "message_files";
  /** The row's id column, for clearing in batches. */
  id: string;
  /** Columns that point at a file. */
  refs: string[];
  /**
   * Which rows: SQL over the table aliased `x`, with $1 closed months, $2 old months, $3 preview days. Times are the
   * database's own (`now()`): every date these compare (won, lost, added, opened) was written on its clock.
   */
  where: string;
};

const KEPT = "x.status = 'ready' AND x.sha256 IS NOT NULL";
const CHAT = (where: string): Part[] => [
  { table: "whatsapp_media", id: "id", refs: ["sha256"], where },
  { table: "instagram_media", id: "id", refs: ["sha256"], where },
];

/** What each clean-up clears. Lead details, notes, tasks and every message's words are never in any of them. */
export const PARTS: Record<CleanKind, Part[]> = {
  // Won or lost (a reopened lead has neither date) the chosen months ago, not in the trash; only files from before it
  // closed (a photo a won customer sent last week is still in use).
  closed: CHAT(
    `${KEPT} AND EXISTS (SELECT 1 FROM leads l WHERE l.id = x.lead_id AND l.deleted_at IS NULL
       AND greatest(l.won_at, l.lost_at) < now() - make_interval(months => $1)
       AND x.created_at < greatest(l.won_at, l.lost_at))`,
  ),
  trash: CHAT(
    `${KEPT} AND EXISTS (SELECT 1 FROM leads l WHERE l.id = x.lead_id AND l.deleted_at IS NOT NULL)`,
  ),
  // The one that reaches open leads: never ticked unless the admin ticks it.
  old: CHAT(`${KEPT} AND x.created_at < now() - make_interval(months => $2)`),
  previews: [
    {
      table: "file_previews",
      id: "sha256",
      refs: ["thumb_sha256", "pdf_sha256"],
      where: "x.state = 'ready' AND x.opened_at < now() - make_interval(days => $3)",
    },
  ],
  library: [
    {
      table: "message_files",
      id: "id",
      refs: ["sha256"],
      where:
        "x.archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_template_submissions t WHERE t.header_file_id = x.id)",
    },
  ],
};

/** The parameters every Part's `where` reads, in order. */
export const partParams = (closedMonths: number) => [closedMonths, OLD_FILE_MONTHS, PREVIEW_IDLE_DAYS];
/**
 * Types all three parameters whichever parts a statement uses (Postgres refuses one it can't type, and some parts read
 * none of them): put first in the statement's WITH.
 */
export const PARAMS_CTE = "params AS (SELECT $1::int AS closed, $2::int AS old, $3::int AS idle)";

/** One row per reference a set of parts would clear: the file it points at, and the row it's on. */
export function refsSql(parts: Part[]): string {
  return parts
    .flatMap((p) =>
      p.refs.map(
        (col) =>
          `SELECT x.${col} AS sha256, '${p.table}:' || x.${p.id}::text AS rid FROM ${p.table} x ` +
          `WHERE ${p.where} AND x.${col} IS NOT NULL`,
      ),
    )
    .join(" UNION ALL ");
}

/** How many rows a set of parts clears, and the bytes that come back: files whose every reference is among them. */
export async function measureParts(
  c: Pick<pg.PoolClient, "query">,
  parts: Part[],
  params: unknown[],
): Promise<{ files: number; bytes: number }> {
  // Only LUME's own constants are joined in (PARTS' tables, columns and conditions); every value is a parameter.
  const measure = `WITH ${PARAMS_CTE}, c AS (${refsSql(parts)}), per AS (SELECT sha256, count(*) AS n FROM c GROUP BY sha256)
       SELECT (SELECT count(DISTINCT rid) FROM c) AS files,
              coalesce((SELECT sum(f.size) FROM per JOIN whatsapp_files f USING (sha256) WHERE per.n >= f.refs), 0) AS bytes`;
  const r = await c.query<{ files: string; bytes: string }>(measure, params);
  return { files: Number(r.rows[0]!.files), bytes: Number(r.rows[0]!.bytes) };
}

export type KindKey = "whatsapp" | "instagram" | "previews" | "library" | "chat" | "database";
export type Survey = {
  disk: { total: number; free: number } | null;
  kinds: { key: KindKey; bytes: number; files: number }[];
  /** What else is on the disk (the system, other apps); null when the disk can't be read. */
  other: number | null;
  candidates: { kind: CleanKind; bytes: number; files: number }[];
  measuredAt: string;
};

/** Each file once, in the first kind that points at it: chats, then Instagram, previews, the library, Team Chat. */
const KINDS_SQL = `
  WITH k AS (
    SELECT sha256, 1 AS o FROM whatsapp_media WHERE sha256 IS NOT NULL
    UNION ALL SELECT sha256, 2 FROM instagram_media WHERE sha256 IS NOT NULL
    UNION ALL SELECT photo_sha256, 2 FROM instagram_threads WHERE photo_sha256 IS NOT NULL
    UNION ALL SELECT photo_sha256, 2 FROM instagram_accounts WHERE photo_sha256 IS NOT NULL
    UNION ALL SELECT thumb_sha256, 3 FROM file_previews WHERE thumb_sha256 IS NOT NULL
    UNION ALL SELECT pdf_sha256, 3 FROM file_previews WHERE pdf_sha256 IS NOT NULL
    UNION ALL SELECT sha256, 4 FROM message_files
    UNION ALL SELECT h, 5 FROM lume_chat_file_hashes() AS h
  ), first AS (SELECT sha256, min(o) AS o FROM k GROUP BY sha256)
  SELECT first.o, count(*) AS files, sum(f.size) AS bytes FROM first JOIN whatsapp_files f USING (sha256) GROUP BY first.o`;
const ORDER: KindKey[] = ["whatsapp", "instagram", "previews", "library", "chat"];

/** Reads with every lead in view (chat files sit under the leads' row-level security), in one transaction. */
async function allLeads<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
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

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Survey }>();
/** Forgets what was measured (after a clean-up, or a setting that changes what counts). */
export const forgetSurvey = () => cache.clear();

/**
 * The disk, what's on it by kind, and each clean-up's yield. Measured at most every 5 minutes per lookback (the
 * queries group every file once; a large LUME takes a moment, so a page opened twice doesn't pay twice).
 */
export async function survey(
  pool: pg.Pool,
  files: FilesDeps | undefined,
  o: { closedMonths: number; now: Date; fresh?: boolean },
): Promise<Survey> {
  const key = String(o.closedMonths);
  const hit = cache.get(key);
  if (!o.fresh && hit && o.now.getTime() - hit.at < CACHE_MS) return hit.value;
  const measured = await allLeads(pool, async (c) => {
    const byKind = await c.query<{ o: number; files: string; bytes: string }>(KINDS_SQL);
    const db = await c.query<{ n: string }>("SELECT pg_database_size(current_database()) AS n");
    const params = partParams(o.closedMonths);
    const candidates = [];
    for (const kind of CLEAN_KINDS)
      candidates.push({ kind, ...(await measureParts(c, PARTS[kind], params)) });
    return { byKind: byKind.rows, db: Number(db.rows[0]!.n), candidates };
  });
  const kinds: Survey["kinds"] = ORDER.map((key, i) => {
    const row = measured.byKind.find((r) => Number(r.o) === i + 1);
    return { key, bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
  });
  kinds.push({ key: "database", bytes: measured.db, files: 0 });
  const disk = files ? await files.disk().catch(() => null) : null;
  const lume = kinds.reduce((a, k) => a + k.bytes, 0);
  const value: Survey = {
    disk,
    kinds,
    other: disk ? Math.max(0, disk.total - disk.free - lume) : null,
    candidates: measured.candidates,
    measuredAt: o.now.toISOString(),
  };
  cache.set(key, { at: o.now.getTime(), value });
  return value;
}
