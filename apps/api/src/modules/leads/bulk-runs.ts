import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { can, canOnRecord, newId, normalizePhone } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { leadFilters, refuseCapped, resolveSearch, tagsFor, type FilterQuery } from "./query";
import { deleteLead, recordActivity, visibleLead } from "./service";
import type { LeadRow } from "./serialize";
import { assignLead, moveStage } from "./write";

/**
 * Phase 7B: every bulk action is a run (bulk_runs, 0049), each lead in it an item holding its before-values.
 * Up to INLINE leads run inside the request; more are queued and run in chunks, each chunk its own transaction
 * as the person. Every lead is still checked on its own, exactly as a single bulk edit checks it.
 */
export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string; lostNote?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" }
  | { type: "set_phone_country"; country: string };

export type Selection = { ids: string[] } | { filters: FilterQuery; except?: string[]; expected?: number };
export type RunRow = typeof schema.bulkRuns.$inferSelect;
type Item = { leadId: string; position: number };

const R = schema.bulkRuns;
const I = schema.bulkRunItems;
const DEFAULTS = { cap: 50_000, inline: 500, chunk: 500 };
const UNDO_HOURS = 24;
let cap = DEFAULTS.cap;
let inlineMax = DEFAULTS.inline;
let chunkSize = DEFAULTS.chunk;
export const setBulkCapForTests = (n: number | null) => void (cap = n ?? DEFAULTS.cap);
export const setInlineMaxForTests = (n: number | null) => void (inlineMax = n ?? DEFAULTS.inline);
export const setChunkForTests = (n: number | null) => void (chunkSize = n ?? DEFAULTS.chunk);

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
    `Narrow the selection: up to ${cap.toLocaleString("en-US")} leads at a time.`,
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
    if (ids.length > cap) throw tooMany();
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
    .limit(cap + 1);
  if (!rows.length) throw nothing();
  if (rows.length > cap) throw tooMany();
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

/** Make a run: inline (≤ INLINE leads, answered at once) or queued (answered 202, run in chunks). */
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
  if (ids.length > inlineMax) {
    req.afterCommit(() => void o.enqueue?.(id));
    const [row] = await req.db.select().from(R).where(eq(R.id, id));
    return { status: 202, run: runView(row!, o.now) };
  }
  await req.db.update(R).set({ status: "running", startedAt: o.now }).where(eq(R.id, id));
  const [run] = await req.db.select().from(R).where(eq(R.id, id));
  await applyItems(
    req,
    run!,
    ids.map((leadId, i) => ({ leadId, position: i + 1 })),
  );
  const done = await finishRun(req, id, "done", o.now);
  return { status: 200, run: runView(done, o.now) };
}

/** What the action is about to change, as it is now: what undo would put back. */
function beforeOf(action: BulkAction, lead: LeadRow, tagIds: string[]): Record<string, unknown> {
  switch (action.type) {
    case "assign":
      return { ownerId: lead.ownerId };
    case "stage":
      return { stageId: lead.stageId, lostReasonId: lead.lostReasonId, lostNote: lead.lostNote };
    case "tags":
      return { tagIds };
    case "delete":
      return { deletedAt: null };
    case "set_phone_country":
      return {
        phoneE164: lead.phoneE164,
        phoneCountryIso: lead.phoneCountryIso,
        phoneStatus: lead.phoneStatus,
      };
  }
}

/** One lead, through the same functions a single edit uses (its history, activities and automations). */
async function applyOne(req: FastifyRequest, lead: LeadRow, action: BulkAction) {
  switch (action.type) {
    case "stage":
      await moveStage(req, lead, {
        stageId: action.stageId,
        lostReasonId: action.lostReasonId,
        ...(action.lostNote ? { lostNote: action.lostNote } : {}),
      });
      return;
    case "assign":
      await assignLead(req, lead, { ownerId: action.ownerId, reason: "bulk" });
      return;
    case "delete":
      await deleteLead(req, lead.id);
      return;
    case "tags":
      if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
      if (action.remove?.length)
        await req.db.execute(
          sql`DELETE FROM lead_tags WHERE lead_id = ${lead.id} AND tag_id = ANY(${`{${action.remove.join(",")}}`}::uuid[])`,
        );
      if (action.add?.length)
        await req.db
          .insert(schema.leadTags)
          .values(action.add.map((tagId) => ({ leadId: lead.id, tagId })))
          .onConflictDoNothing();
      await req.db
        .update(schema.leads)
        .set({ version: sql`${schema.leads.version} + 1` })
        .where(eq(schema.leads.id, lead.id));
      await recordActivity(req, lead.id, "field_changed", { fields: ["tags"] });
      return;
    case "set_phone_country": {
      // Spec §10: the number as typed, read again with a country; the history records only the country.
      if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
      if (lead.phoneStatus === "valid") throw badRequest("ALREADY_VALID", "Already a number LUME can read");
      if (!lead.phoneRaw) throw badRequest("NO_NUMBER", "No number");
      const p = normalizePhone(lead.phoneRaw, action.country);
      if (p.status !== "valid") throw badRequest("STILL_INVALID", "Still not a number LUME can read");
      await req.db
        .update(schema.leads)
        .set({
          phoneE164: p.e164,
          phoneCountryIso: p.countryIso,
          phoneStatus: "valid",
          version: sql`${schema.leads.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.leads.id, lead.id));
      await recordActivity(req, lead.id, "phone_country_set", { country: action.country });
      return;
    }
  }
}

/**
 * Some of a run's items, in one transaction as the person. A lead they may not touch is skipped with its reason
 * (rolled back to its savepoint); anything else that fails rolls the whole chunk back, to be run again.
 */
export async function applyItems(req: FastifyRequest, run: RunRow, items: Item[]) {
  const action = run.action as BulkAction;
  const tagsOf =
    action.type === "tags"
      ? await tagsFor(
          req,
          items.map((i) => i.leadId),
        )
      : new Map<string, string[]>();
  const results: {
    lead_id: string;
    result: "done" | "skipped";
    code: string | null;
    before: unknown;
    after_version: number | null;
  }[] = [];
  for (const [n, item] of items.entries()) {
    const sp = sql.raw(`bulk_${n}`);
    await req.db.execute(sql`SAVEPOINT ${sp}`);
    try {
      const lead = await visibleLead(req, item.leadId);
      if (!canOnRecord(req.actor!, "leads.bulk_edit", lead.ownerId)) throw forbidden();
      const before = beforeOf(action, lead, tagsOf.get(lead.id) ?? []);
      await applyOne(req, lead, action);
      const [after] = await req.db
        .select({ version: schema.leads.version })
        .from(schema.leads)
        .where(eq(schema.leads.id, lead.id));
      await req.db.execute(sql`RELEASE SAVEPOINT ${sp}`);
      results.push({
        lead_id: item.leadId,
        result: "done",
        code: null,
        before,
        after_version: after?.version ?? null,
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT ${sp}`);
      results.push({
        lead_id: item.leadId,
        result: "skipped",
        code: err.code,
        before: null,
        after_version: null,
      });
    }
  }
  await req.db.execute(sql`
    UPDATE bulk_run_items i SET result = r.result, code = r.code, before = r.before, after_version = r.after_version
      FROM jsonb_to_recordset(${JSON.stringify(results)}::jsonb)
           AS r(lead_id uuid, result text, code text, before jsonb, after_version int)
     WHERE i.run_id = ${run.id} AND i.lead_id = r.lead_id`);
  const skippedBy: Record<string, number> = {};
  for (const r of results) if (r.code) skippedBy[r.code] = (skippedBy[r.code] ?? 0) + 1;
  const done = results.filter((r) => r.result === "done").length;
  // Counts add up chunk by chunk; the reasons merge key by key.
  await req.db.execute(sql`
    UPDATE bulk_runs SET done = done + ${done}, skipped = skipped + ${results.length - done},
      skipped_by = coalesce((SELECT jsonb_object_agg(key, total) FROM (
          SELECT key, sum(value::int) AS total FROM (
            SELECT * FROM jsonb_each_text(skipped_by) UNION ALL SELECT * FROM jsonb_each_text(${JSON.stringify(skippedBy)}::jsonb)
          ) x GROUP BY key) y), '{}'::jsonb)
     WHERE id = ${run.id}`);
}

/** The end of a run: its status, and one audit entry for the whole of it (never one per lead). */
async function finishRun(
  req: FastifyRequest,
  id: string,
  status: "done" | "cancelled" | "failed",
  now: Date,
  error?: string,
) {
  const [row] = await req.db
    .update(R)
    .set({ status, finishedAt: now, ...(error ? { error } : {}) })
    .where(eq(R.id, id))
    .returning();
  const action = row!.action as BulkAction;
  await audit(req, {
    action: "lead.bulk",
    entityType: "lead",
    diff: {
      type: action.type,
      run: id,
      status,
      total: row!.total,
      updated: row!.done,
      skipped: row!.skipped,
      selection: (row!.selection as { kind: string }).kind,
    },
  });
  return row!;
}

/**
 * A queued run, chunk by chunk (the bulk queue's job). Only pending items are taken, so a run picked up again
 * after a crash carries on from the last committed chunk and never does one twice.
 */
/** What a queued run needs: the app, a pool of its own, and the clock (tests move it). */
export type RunDeps = { app: FastifyInstance; pool: pg.Pool; clock?: () => Date };

export async function processRun(o: RunDeps, runId: string): Promise<void> {
  const now = () => (o.clock ? o.clock() : new Date());
  const app = jobServer(o.app);
  const db = drizzle(o.pool, { schema });
  const [claimed] = await db
    .update(R)
    .set({ status: "running", startedAt: sql`coalesce(${R.startedAt}, ${now()})` })
    .where(and(eq(R.id, runId), sql`${R.status} IN ('queued', 'running')`))
    .returning();
  if (!claimed) return;
  for (let n = 0; ; n++) {
    const actor = await loadActor(o.pool, claimed.userId);
    if (!actor || !can(actor, "leads.bulk_edit")) {
      await db
        .update(R)
        .set({ status: "failed", error: "Their access changed", finishedAt: now() })
        .where(eq(R.id, runId));
      return;
    }
    const more = await withJobRequest(
      { app, pool: o.pool, actor, requestId: `bulk:${runId}:${n}`, allLeads: false },
      async (req) => {
        const items = await req.db
          .select({ leadId: I.leadId, position: I.position })
          .from(I)
          .where(and(eq(I.runId, runId), eq(I.result, "pending")))
          .orderBy(asc(I.position))
          .limit(chunkSize);
        if (!items.length) {
          await finishRun(req, runId, "done", now());
          return false;
        }
        await applyItems(req, claimed, items);
        return true;
      },
    );
    if (!more) return;
  }
}

export async function readRun(req: FastifyRequest, id: string, now: Date) {
  const [row] = await req.db.select().from(R).where(eq(R.id, id));
  if (!row || (row.userId !== req.actor!.userId && !can(req.actor!, "leads.bulk_edit", "all")))
    throw notFound("RUN_NOT_FOUND", "No such bulk action");
  return runView(row, now);
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
