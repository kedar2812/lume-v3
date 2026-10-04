import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError, badRequest, conflict, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import type { NewNotification } from "../notifications/notify";
import { UNDO_HOURS, limits, type BulkAction, type RunRow, type Selection } from "./bulk-config";
import { applyItems, finishRun, runNotices } from "./bulk-engine";
import { leadFilters, refuseCapped, resolveSearch } from "./query";

export {
  setBulkCapForTests,
  setChunkForTests,
  setInlineMaxForTests,
  type BulkAction,
  type Selection,
} from "./bulk-config";
export { processRun, type RunDeps } from "./bulk-engine";

/**
 * Phase 7B: every bulk action is a run (bulk_runs, 0049), each lead in it an item holding its before-values.
 * Up to 500 leads run inside the request; more are queued and run in chunks (bulk-engine), each chunk its own
 * transaction as the person.
 */
const R = schema.bulkRuns;
const I = schema.bulkRunItems;

/** A run as the API gives it. */
export function runView(r: RunRow, now: Date) {
  const undoUntil = r.finishedAt ? new Date(r.finishedAt.getTime() + UNDO_HOURS * 3_600_000) : null;
  return {
    id: r.id,
    userId: r.userId,
    action: r.action,
    selection: r.selection,
    status: r.status,
    total: r.total,
    done: r.done,
    skipped: r.skipped,
    failed: r.failed,
    skippedBy: r.skippedBy,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    undoOf: r.undoOf,
    undoUntil,
    canUndo:
      ["done", "cancelled", "failed"].includes(r.status) &&
      r.done > 0 &&
      !r.undoOf &&
      !!undoUntil &&
      now < undoUntil,
  };
}

/** What can be refused before any lead is touched: the action itself. Per-lead refusals are skips. */
async function checkAction(req: FastifyRequest, action: BulkAction) {
  if (action.type === "assign" && action.ownerId) {
    const [u] = await req.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, action.ownerId), eq(schema.users.status, "active")));
    if (!u) throw badRequest("UNKNOWN_USER", "That person doesn't exist or is disabled");
  }
  if (action.type !== "tags") return;
  const all = [...(action.add ?? []), ...(action.remove ?? [])];
  if (!all.length) throw badRequest("NOTHING_TO_DO", "Add or remove at least one tag");
  const found = await req.db
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(sql`${schema.tags.id} = ANY(${`{${all.join(",")}}`}::uuid[])`);
  if (found.length !== new Set(all).size) throw badRequest("UNKNOWN_TAG", "One of those tags doesn't exist");
}

const tooMany = () =>
  new HttpError(
    422,
    "TOO_MANY",
    `Narrow the selection: up to ${limits.cap.toLocaleString("en-US")} leads at a time.`,
  );
const nothing = () => new HttpError(422, "NOTHING_SELECTED", "No leads are selected.");

/**
 * The selection, as ids, read as the person: picked ids as given (each is checked when its turn comes), or every
 * lead the filter shows them, minus the ones they unticked. Snapshotted into the run, so it can't drift.
 */
async function resolveSelection(req: FastifyRequest, sel: Selection) {
  if ("ids" in sel) {
    const ids = [...new Set(sel.ids)];
    if (!ids.length) throw nothing();
    if (ids.length > limits.cap) throw tooMany();
    return { ids, words: { kind: "ids", total: ids.length } };
  }
  const fields = await loadFieldRegistry(req);
  // A capped search can't be a selection: it would act on whichever part of the matches came first.
  const hits = refuseCapped(await resolveSearch(req, sel.filters, fields));
  const where = leadFilters(req, sel.filters, fields, hits);
  const except = [...new Set(sel.except ?? [])];
  if (except.length) where.push(sql`${schema.leads.id} <> ALL(${`{${except.join(",")}}`}::uuid[])`);
  const rows = await req.db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(and(...where))
    .orderBy(desc(schema.leads.id))
    .limit(limits.cap + 1);
  if (!rows.length) throw nothing();
  if (rows.length > limits.cap) throw tooMany();
  // Far more than the person was shown (counts that failed or went stale on their screen): refused, so the number
  // they confirmed is the number acted on. A few arrivals since they looked are fine (7C final review, Important 1).
  const shown = sel.expected;
  if (shown !== undefined && rows.length + except.length > shown * 1.1 + 25)
    throw conflict(
      "MATCH_CHANGED",
      `${rows.length.toLocaleString("en-US")} leads match these filters now, not the ${shown.toLocaleString("en-US")} shown. Look again, then choose.`,
    );
  return {
    ids: rows.map((r) => r.id),
    words: {
      kind: "filter",
      filters: sel.filters,
      except: except.length,
      total: rows.length,
      ...(sel.expected !== undefined ? { expected: sel.expected } : {}),
    },
  };
}

/** Make a run: inline (≤ 500 leads, answered at once) or queued (answered 202, run in chunks). */
export async function createRun(
  req: FastifyRequest,
  o: { selection: Selection; action: BulkAction; enqueue?: (id: string) => Promise<void>; now: Date },
): Promise<{ status: 200 | 202; run: ReturnType<typeof runView> }> {
  await checkAction(req, o.action);
  const { ids, words } = await resolveSelection(req, o.selection);
  const id = newId();
  await req.db.insert(R).values({
    id,
    userId: req.actor!.userId,
    action: o.action,
    selection: words,
    total: ids.length,
    createdAt: o.now,
  });
  await req.db.execute(sql`
    INSERT INTO bulk_run_items (run_id, lead_id, position)
    SELECT ${id}, t.lead_id, t.ord FROM unnest(${`{${ids.join(",")}}`}::uuid[]) WITH ORDINALITY AS t(lead_id, ord)`);
  return startRun(req, id, ids.length, o);
}

/** A run whose items are in: inline (≤ 500, answered at once) or queued (answered 202, run in chunks). */
async function startRun(
  req: FastifyRequest,
  id: string,
  total: number,
  o: { enqueue?: (id: string) => Promise<void>; now: Date },
): Promise<{ status: 200 | 202; run: ReturnType<typeof runView> }> {
  if (total > limits.inline) {
    req.afterCommit(() => void o.enqueue?.(id));
    const [row] = await req.db.select().from(R).where(eq(R.id, id));
    return { status: 202, run: runView(row!, o.now) };
  }
  const [run] = await req.db
    .update(R)
    .set({ status: "running", startedAt: o.now })
    .where(eq(R.id, id))
    .returning();
  const items = await req.db
    .select({ leadId: I.leadId, position: I.position })
    .from(I)
    .where(eq(I.runId, id))
    .orderBy(asc(I.position));
  await applyItems(req, run!, items);
  const done = await finishRun(req, id, "done", o.now);
  // The new owner hears once, after the commit; the maker has their answer right here.
  const notices: [string, NewNotification][] = [];
  await runNotices(req.db, done, async (u, n) => void notices.push([u, n]), { maker: false });
  req.afterCommit(() => {
    for (const [u, n] of notices) void req.server.notify?.(u, n).catch(() => undefined);
  });
  return { status: 200, run: runView(done, o.now) };
}

/**
 * Undo a run, within 24 hours, by its maker or someone with leads.bulk_edit at 'all'. It is a run too: each lead it
 * changed goes back only if nobody has changed it since. A run is undone once, and an undo can't be undone.
 */
export async function undoRun(
  req: FastifyRequest,
  id: string,
  o: { enqueue?: (id: string) => Promise<void>; now: Date },
) {
  const run = await ownRun(req, id);
  if (run.undoOf) throw new HttpError(422, "NOT_UNDOABLE", "An undo can't be undone.");
  const [prior] = await req.db.select({ id: R.id }).from(R).where(eq(R.undoOf, id));
  if (run.status === "undone" || prior)
    throw conflict("ALREADY_UNDONE", "That bulk action has already been undone.");
  if (run.status === "queued" || run.status === "running")
    throw new HttpError(422, "NOT_UNDOABLE", "That bulk action is still running. Stop it, or let it finish.");
  if (!run.finishedAt || o.now.getTime() > run.finishedAt.getTime() + UNDO_HOURS * 3_600_000)
    throw new HttpError(422, "UNDO_EXPIRED", "Undo is available for 24 hours after a bulk action.");
  if (run.done === 0) throw new HttpError(422, "NOT_UNDOABLE", "That bulk action didn't change any leads.");
  const undo = newId();
  await req.db.insert(R).values({
    id: undo,
    userId: req.actor!.userId,
    action: { type: "undo", of: (run.action as BulkAction).type },
    selection: { kind: "undo", of: id, total: run.done },
    total: run.done,
    undoOf: id,
    createdAt: o.now,
  });
  const { rowCount } = await req.db.execute(sql`
    INSERT INTO bulk_run_items (run_id, lead_id, position)
    SELECT ${undo}, lead_id, row_number() OVER (ORDER BY position) FROM bulk_run_items
     WHERE run_id = ${id} AND result = 'done'`);
  if (rowCount !== run.done)
    await req.db
      .update(R)
      .set({ total: rowCount ?? 0 })
      .where(eq(R.id, undo));
  return startRun(req, undo, rowCount ?? run.done, o);
}

/** The run, for its maker or someone with leads.bulk_edit at 'all'; anyone else gets "no such run". */
async function ownRun(req: FastifyRequest, id: string) {
  const [row] = await req.db.select().from(R).where(eq(R.id, id));
  if (!row || (row.userId !== req.actor!.userId && !can(req.actor!, "leads.bulk_edit", "all")))
    throw notFound("RUN_NOT_FOUND", "No such bulk action");
  return row;
}

export async function readRun(req: FastifyRequest, id: string, now: Date) {
  return runView(await ownRun(req, id), now);
}

/** Stop a run after the chunk it's on; what's done stays done (and can be undone). */
export async function cancelRun(req: FastifyRequest, id: string, now: Date) {
  const row = await ownRun(req, id);
  if (row.status !== "queued" && row.status !== "running")
    throw conflict("RUN_FINISHED", "That bulk action has already finished");
  const [updated] = await req.db.update(R).set({ cancelRequested: true }).where(eq(R.id, id)).returning();
  return runView(updated!, now);
}

/** The person's runs from the last 7 days, newest first; someone with leads.bulk_edit at 'all' sees everyone's. */
export async function listRuns(req: FastifyRequest, now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const everyone = can(req.actor!, "leads.bulk_edit", "all");
  const rows = await req.db
    .select()
    .from(R)
    .where(and(gte(R.createdAt, since), everyone ? undefined : eq(R.userId, req.actor!.userId)))
    .orderBy(desc(R.createdAt))
    .limit(200);
  return rows.map((r) => runView(r, now));
}

/** POST /leads/bulk (≤ 100 picked leads, as before): the same answer, through a run. */
export async function bulkAnswer(req: FastifyRequest, ids: string[], action: BulkAction, now: Date) {
  const { run } = await createRun(req, { selection: { ids }, action, now });
  const items = await req.db
    .select({ leadId: I.leadId, result: I.result, code: I.code })
    .from(I)
    .where(eq(I.runId, run.id))
    .orderBy(asc(I.position));
  return {
    updated: items.filter((i) => i.result === "done").map((i) => i.leadId),
    skipped: items.filter((i) => i.result === "skipped").map((i) => ({ id: i.leadId, code: i.code! })),
  };
}

/**
 * A run's items (each lead's before-values) are kept 30 days after it finishes, long past its 24-hour undo; then
 * they're cleared. The run itself stays, with its counts, as the audit log's entry does (the hourly tick).
 */
export async function clearOldBulkItems(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM bulk_run_items WHERE run_id IN (
       SELECT id FROM bulk_runs WHERE finished_at < now() - interval '30 days')`,
  );
  return rowCount ?? 0;
}
