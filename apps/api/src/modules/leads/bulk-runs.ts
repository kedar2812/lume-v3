import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
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
  if (ids.length > limits.inline) {
    req.afterCommit(() => void o.enqueue?.(id));
    const [row] = await req.db.select().from(R).where(eq(R.id, id));
    return { status: 202, run: runView(row!, o.now) };
  }
  const [run] = await req.db
    .update(R)
    .set({ status: "running", startedAt: o.now })
    .where(eq(R.id, id))
    .returning();
  await applyItems(
    req,
    run!,
    ids.map((leadId, i) => ({ leadId, position: i + 1 })),
  );
  const done = await finishRun(req, id, "done", o.now);
  // The new owner hears once, after the commit; the maker has their answer right here.
  const notices: [string, NewNotification][] = [];
  await runNotices(req.db, done, async (u, n) => void notices.push([u, n]), { maker: false });
  req.afterCommit(() => {
    for (const [u, n] of notices) void req.server.notify?.(u, n).catch(() => undefined);
  });
  return { status: 200, run: runView(done, o.now) };
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
