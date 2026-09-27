import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError, notFound } from "../../http/errors";
import { requestSync } from "./requests";
import { sheetsOn } from "./service";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const RF = schema.sourceRefreshes;
/** Amendment A9: the same press twice, and a sync this fresh, aren't worth doing again. */
const SAME_PRESS_MS = 3000;
const FRESH_SYNC_MS = 10_000;
const GLOW_MAX = 20;
const ATTENTION_CODES = new Set([
  "ACCESS_LOST",
  "SHEET_GONE",
  "TAB_GONE",
  "COLUMNS_CHANGED",
  "TOO_MANY_ROWS",
  "RUN_AS_ACCESS",
]);

export type RefreshProgress = {
  status: "running" | "done";
  rowsRead: number;
  rowsTotal: number;
  created: number;
  merged: number;
  leadIds: string[];
  unreachable: boolean;
  attention: { id: string; name: string }[];
};

/** Spec §8.1: Refresh shows with Sheets on and one sheet active; admins also hear what needs attention. */
export async function sheetsStatus(req: FastifyRequest, d: AppDeps) {
  if (!d.google || !(await sheetsOn(req))) return { refresh: false, attention: [] };
  const rows = await req.db
    .select({ id: S.id, name: S.name, status: S.status })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "needs_attention"])));
  return {
    refresh: rows.some((r) => r.status === "active"),
    attention: can(req.actor!, "integrations.manage")
      ? rows.filter((r) => r.status === "needs_attention").map(({ id, name }) => ({ id, name }))
      : [],
  };
}

export async function startRefresh(req: FastifyRequest, d: AppDeps): Promise<{ id: string }> {
  if (!d.google || !(await sheetsOn(req)))
    throw new HttpError(409, "SHEETS_OFF", "Google Sheets is switched off.");
  const me = req.actor!.userId;
  const [recent] = await req.db
    .select({ id: RF.id })
    .from(RF)
    .where(and(eq(RF.requestedBy, me), gt(RF.createdAt, new Date(Date.now() - SAME_PRESS_MS))))
    .orderBy(desc(RF.createdAt))
    .limit(1);
  if (recent) return { id: recent.id };
  const sources = await req.db
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), eq(S.status, "active")));
  if (!sources.length) throw new HttpError(409, "NO_SHEETS", "No Google Sheet is connected.");
  const syncIds: string[] = [];
  const fresh: string[] = [];
  for (const s of sources) {
    const r = await requestSync(req.db, {
      sourceId: s.id,
      trigger: "refresh",
      requestedBy: me,
      reuseWithinMs: FRESH_SYNC_MS,
    });
    if (!r) continue;
    syncIds.push(r.syncId);
    if (r.fresh) fresh.push(r.syncId);
  }
  const id = newId();
  await req.db.insert(RF).values({ id, requestedBy: me, syncIds });
  req.afterCommit(() => fresh.forEach((s) => void d.sheets?.enqueue(s)));
  return { id };
}

/**
 * Spec §8.2: progress summed over the syncs this refresh started or joined. The counts are of leads the
 * viewer can see — the query runs under their own row-level security — so a rep hears "for you".
 */
export async function refreshProgress(req: FastifyRequest, id: string): Promise<RefreshProgress> {
  const [r] = await req.db
    .select()
    .from(RF)
    .where(and(eq(RF.id, id), eq(RF.requestedBy, req.actor!.userId)));
  if (!r) throw notFound("REFRESH_NOT_FOUND", "Refresh not found");
  const syncs = r.syncIds.length
    ? await req.db
        .select({ s: SY, name: S.name, sourceStatus: S.status })
        .from(SY)
        .innerJoin(S, eq(S.id, SY.sourceId))
        .where(inArray(SY.id, r.syncIds))
    : [];
  const running = syncs.some((x) => x.s.status === "queued" || x.s.status === "running");
  const { rows } = r.syncIds.length
    ? await req.db.execute<{ result: "created" | "merged"; lead_id: string }>(sql`
        SELECT sr.result, sr.lead_id FROM source_rows sr
        JOIN leads l ON l.id = sr.lead_id AND l.deleted_at IS NULL
        WHERE sr.sync_id = ANY(string_to_array(${r.syncIds.join(",")}, ',')::uuid[]) AND sr.result IN ('created', 'merged')
        ORDER BY sr.result, sr.id DESC`)
    : { rows: [] };
  const created = rows.filter((x) => x.result === "created");
  const merged = rows.filter((x) => x.result === "merged");
  const failedAll = syncs.length > 0 && syncs.every((x) => x.s.status === "failed");
  return {
    status: running ? "running" : "done",
    rowsRead: syncs.reduce((n, x) => n + x.s.rowsRead, 0),
    rowsTotal: syncs.reduce((n, x) => n + x.s.rowsTotal, 0),
    created: created.length,
    merged: merged.length,
    leadIds: [...new Set([...created, ...merged].map((x) => x.lead_id))].slice(0, GLOW_MAX),
    // Unreachable: every sync failed for a passing reason (not something a person must fix).
    unreachable: !running && failedAll && syncs.every((x) => !ATTENTION_CODES.has(x.s.error ?? "")),
    attention: can(req.actor!, "integrations.manage")
      ? syncs
          .filter((x) => x.sourceStatus === "needs_attention")
          .map((x) => ({ id: x.s.sourceId, name: x.name }))
      : [],
  };
}
