import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, localDayBounds, newId, render } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { prepareMessage } from "../leads/messages";
import { leadFilters, orderBy } from "../leads/query";
import { filterQuerySchema } from "../leads/routes";
import { confirmSend, contextFor, type MoveResult } from "../leads/sending";
import type { LeadRow } from "../leads/serialize";
import { visibleLead } from "../leads/service";
import { readMessaging } from "../settings/messaging";
import { timezoneOf } from "../tasks/service";
import { oneTemplate } from "../templates/service";
import { stale, viewById } from "../views/service";

const Q = schema.sendQueues;
const I = schema.sendQueueItems;
const L = schema.leads;
type QueueRow = typeof Q.$inferSelect;
type ItemRow = typeof I.$inferSelect;

export type QueueItemView = {
  position: number;
  leadId: string;
  name: string;
  stageName: string | null;
  status: ItemRow["status"];
  reason: string | null;
};
export type QueueView = {
  id: string;
  status: QueueRow["status"];
  /** Why it's paused: "daily_cap" (LUME paused it until tomorrow), or null (the person did). */
  pausedReason: string | null;
  /** The template the run planned with, by its name now; null: the person's own words. */
  templateName: string | null;
  /** Why these leads: the view's name when the run started, or "Your selection" (plan ruling R3). */
  sourceName: string;
  total: number;
  done: { sent: number; notSent: number; skipped: number };
  today: { sent: number; cap: number };
  items: QueueItemView[];
};
/** What LUME did with an item, and where the run goes next (null: nothing left, and it's finished). */
export type Step = { next: number | null; finished?: true } & Partial<MoveResult>;
/** A refusal that must still be kept (the daily cap pauses the run): answered, not thrown. */
export type Refused = { refused: HttpError };

// Why a lead can't be in a run, or can't be sent now. Never its number (Review Focus 4).
const WHY = {
  noNumber: "No WhatsApp number",
  needsCountry: "The number needs a country code",
  notYours: "Not one you may message",
  gone: "No longer one of your leads, or deleted",
};
/** A run plans from at most this many of a view's leads, however long the view. */
const SCAN = 1000;

function whyNot(req: FastifyRequest, lead: LeadRow): string | null {
  const a = req.actor!;
  if (!canOnRecord(a, "messages.send", lead.ownerId) || !canOnRecord(a, "messages.send_queue", lead.ownerId))
    return WHY.notYours;
  if (lead.phoneStatus === "needs_country") return WHY.needsCountry;
  if (!lead.phoneE164 || lead.phoneStatus !== "valid") return WHY.noNumber;
  return null;
}

/** Starts one person's run at a time (plan ruling R1): the check and the insert can't interleave. */
async function lockPerson(req: FastifyRequest) {
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lume.queue:" + req.actor!.userId}, 0))`,
  );
}
async function openRun(req: FastifyRequest): Promise<QueueRow | undefined> {
  // Row-level security: only the caller's own runs.
  const [q] = await req.db
    .select()
    .from(Q)
    .where(inArray(Q.status, ["active", "paused"]))
    .limit(1);
  return q;
}

async function leadsOfView(req: FastifyRequest, viewId: string) {
  const v = await viewById(req, viewId);
  const parsed = filterQuerySchema.safeParse(v.filters);
  if (!parsed.success || (await stale(req, parsed.data)))
    throw new HttpError(422, "VIEW_STALE", "That view's filters no longer hold. Edit it, then start again");
  const { sort, ...filters } = parsed.data;
  // A view naming no pipeline opens on the default one, as its count does (4B).
  if (!filters.pipelineId) {
    const [byDefault] = await req.db
      .select({ id: schema.pipelines.id })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.isDefault, true));
    if (byDefault) filters.pipelineId = byDefault.id;
  }
  const fields = await loadFieldRegistry(req);
  const rows = await req.db
    .select()
    .from(L)
    .where(and(...leadFilters(req, filters, fields)))
    .orderBy(...orderBy(sort))
    .limit(SCAN);
  return { rows, source: `view:${v.id}`, sourceName: v.name };
}
async function leadsOfSelection(req: FastifyRequest, leadIds: string[]) {
  const ids = [...new Set(leadIds)];
  const found = await req.db
    .select()
    .from(L)
    .where(and(inArray(L.id, ids), isNull(L.deletedAt)));
  const byId = new Map(found.map((r) => [r.id, r]));
  return {
    rows: ids.map((id) => byId.get(id)).filter((r): r is LeadRow => !!r),
    source: "selection",
    sourceName: "Your selection",
  };
}

type Source = { viewId?: string; leadIds?: string[] };
type LeftOut = { name: string; reason: string };

/** Who a run from this view or selection would hold, in order; the start and its preview share it. */
async function planLeads(req: FastifyRequest, body: Source) {
  const { rows, source, sourceName } = body.viewId
    ? await leadsOfView(req, body.viewId)
    : await leadsOfSelection(req, body.leadIds ?? []);
  const { queueSize } = await readMessaging(req);
  const picked: LeadRow[] = [];
  const leftOut: LeftOut[] = [];
  let more = 0;
  for (const r of rows) {
    const why = whyNot(req, r);
    if (why) leftOut.push({ name: r.name, reason: why });
    else if (picked.length < queueSize) picked.push(r);
    else more += 1;
  }
  return { picked, leftOut, more, source, sourceName };
}

/**
 * What a run would hold, before it starts (the start sheet, Task 3): how many, who's left out and why, the
 * day's count against the cap, and the run already open, if any. Nothing is created.
 */
export async function planQueue(
  req: FastifyRequest,
  body: Source,
): Promise<{
  total: number;
  leftOut: LeftOut[];
  more: number;
  today: { sent: number; cap: number };
  open: { id: string; status: QueueRow["status"]; sourceName: string; done: number; total: number } | null;
}> {
  const { picked, leftOut, more } = await planLeads(req, body);
  const run = await openRun(req);
  const open = run ? await queueView(req, run.id) : null;
  const { dailyCap } = await readMessaging(req);
  return {
    total: picked.length,
    leftOut,
    more,
    today: { sent: await sentToday(req), cap: dailyCap },
    open: open && {
      id: open.id,
      status: open.status,
      sourceName: open.sourceName,
      done: open.done.sent + open.done.notSent + open.done.skipped,
      total: open.total,
    },
  };
}

/**
 * Plans a run (spec §5): the leads, under the caller's own row-level security, in the view's order (or the
 * selection's), up to the run size. The list is fixed now (plan ruling R2). Who can't be messaged is left
 * out with why; `more` counts those who could, but wait for the next run.
 */
export async function startQueue(
  req: FastifyRequest,
  body: Source & { templateId?: string },
): Promise<{ queue: QueueView; leftOut: LeftOut[]; more: number }> {
  await lockPerson(req);
  if (await openRun(req)) throw conflict("QUEUE_OPEN", "Finish or end your current run first");
  let versionId: string | null = null;
  if (body.templateId) {
    const t = await oneTemplate(req, body.templateId);
    if (!t.usable) throw forbidden("TEMPLATE_NOT_YOURS", "That template isn't one your role can use");
    versionId = t.versionId;
  }
  const { picked, leftOut, more, source, sourceName } = await planLeads(req, body);
  if (!picked.length)
    throw new HttpError(422, "NOTHING_TO_SEND", "None of these leads can get a WhatsApp message", {
      leftOut,
    });
  const id = newId();
  await req.db.insert(Q).values({
    id,
    userId: req.actor!.userId,
    templateVersionId: versionId,
    source,
    sourceName: sourceName.slice(0, 80),
  });
  await req.db.insert(I).values(picked.map((r, position) => ({ queueId: id, position, leadId: r.id })));
  await audit(req, {
    action: "queue.started",
    entityType: "send_queue",
    entityId: id,
    diff: { source: sourceName, leads: picked.length },
  });
  return { queue: await queueView(req, id), leftOut, more };
}

export async function currentQueue(req: FastifyRequest): Promise<QueueView | null> {
  const q = await openRun(req);
  return q ? queueView(req, q.id) : null;
}

async function queueRow(req: FastifyRequest, id: string, forUpdate = false): Promise<QueueRow> {
  const [q] = forUpdate
    ? await req.db.select().from(Q).where(eq(Q.id, id)).for("update")
    : await req.db.select().from(Q).where(eq(Q.id, id));
  if (!q) throw notFound("QUEUE_NOT_FOUND", "That run doesn't exist");
  return q;
}

export async function queueView(req: FastifyRequest, id: string): Promise<QueueView> {
  const q = await queueRow(req, id);
  const [tpl] = q.templateVersionId
    ? await req.db
        .select({ name: schema.messageTemplates.name })
        .from(schema.templateVersions)
        .innerJoin(
          schema.messageTemplates,
          eq(schema.messageTemplates.id, schema.templateVersions.templateId),
        )
        .where(eq(schema.templateVersions.id, q.templateVersionId))
    : [];
  // A lead the person can no longer see keeps its place, not its name (row-level security hides it).
  const items = await req.db
    .select({
      position: I.position,
      leadId: I.leadId,
      status: I.status,
      reason: I.reason,
      name: L.name,
      stageName: schema.stages.name,
    })
    .from(I)
    .leftJoin(L, eq(L.id, I.leadId))
    .leftJoin(schema.stages, eq(schema.stages.id, L.stageId))
    .where(eq(I.queueId, id))
    .orderBy(asc(I.position));
  const n = (s: ItemRow["status"]) => items.filter((i) => i.status === s).length;
  const { dailyCap } = await readMessaging(req);
  return {
    id: q.id,
    status: q.status,
    pausedReason: q.status === "paused" ? q.pausedReason : null,
    templateName: tpl?.name ?? null,
    sourceName: q.sourceName,
    total: items.length,
    done: { sent: n("sent"), notSent: n("not_sent"), skipped: n("skipped") },
    today: { sent: await sentToday(req), cap: dailyCap },
    items: items.map((i) => ({
      position: i.position,
      leadId: i.leadId,
      name: i.name ?? "A lead you can no longer see",
      stageName: i.stageName ?? null,
      status: i.status,
      reason: i.reason,
    })),
  };
}

/**
 * The person's queued sends since midnight where they are (their own timezone, else the business's):
 * counted from their own runs, so a lead reassigned after it was sent still counts (Review Focus 2).
 */
async function sentToday(req: FastifyRequest, alsoOpen = false): Promise<number> {
  const me = req.actor!.userId;
  const { start } = localDayBounds(new Date(), await timezoneOf(req, me));
  const [row] = await req.db
    .select({ n: sql<number>`count(*)::int` })
    .from(I)
    .innerJoin(Q, eq(Q.id, I.queueId))
    .where(
      and(
        eq(Q.userId, me),
        alsoOpen
          ? sql`(${I.status} = 'sending' OR (${I.status} = 'sent' AND ${I.doneAt} >= ${start}))`
          : sql`${I.status} = 'sent' AND ${I.doneAt} >= ${start}`,
      ),
    );
  return row?.n ?? 0;
}
/** The daily cap, checked before WhatsApp opens: reached, the run pauses with why. */
async function capReached(req: FastifyRequest): Promise<HttpError | null> {
  const { dailyCap } = await readMessaging(req);
  // Sends open in another tab count too, so two tabs can't pass the cap together.
  if ((await sentToday(req, true)) < dailyCap) return null;
  return new HttpError(409, "DAILY_CAP", `You've sent today's ${dailyCap}; the run is paused until tomorrow`);
}

function assertRunning(q: QueueRow) {
  if (q.status === "paused") throw conflict("QUEUE_PAUSED", "This run is paused");
  if (q.status !== "active") throw conflict("QUEUE_OVER", "This run is over");
}
async function itemAt(req: FastifyRequest, id: string, position: number): Promise<ItemRow> {
  const [it] = await req.db
    .select()
    .from(I)
    .where(and(eq(I.queueId, id), eq(I.position, position)));
  if (!it) throw notFound("ITEM_NOT_FOUND", "That lead isn't in this run");
  return it;
}
/** The next lead still to send after this one, else any left before it. */
async function nextPending(req: FastifyRequest, id: string, after: number): Promise<number | null> {
  const rest = await req.db
    .select({ position: I.position })
    .from(I)
    .where(and(eq(I.queueId, id), eq(I.status, "pending")))
    .orderBy(asc(I.position));
  return (rest.find((r) => r.position > after) ?? rest[0])?.position ?? null;
}
async function settle(
  req: FastifyRequest,
  id: string,
  position: number,
  status: ItemRow["status"],
  reason: string | null = null,
) {
  await req.db
    .update(I)
    .set({ status, reason, doneAt: new Date() })
    .where(and(eq(I.queueId, id), eq(I.position, position)));
}
/** Where the run goes after an item: the next lead, or finished when none is pending or open. */
async function step(req: FastifyRequest, id: string, position: number): Promise<Step> {
  const next = await nextPending(req, id, position);
  if (next !== null) return { next };
  const [open] = await req.db
    .select({ position: I.position })
    .from(I)
    .where(and(eq(I.queueId, id), eq(I.status, "sending")))
    .limit(1);
  if (open) return { next: null };
  await req.db.update(Q).set({ status: "finished", finishedAt: new Date() }).where(eq(Q.id, id));
  return { next: null, finished: true };
}

/** The planned version's words, in this lead's words (4A's render; never a contact). */
async function plannedText(req: FastifyRequest, versionId: string, lead: LeadRow) {
  const [v] = await req.db
    .select({ body: schema.templateVersions.body })
    .from(schema.templateVersions)
    .where(eq(schema.templateVersions.id, versionId));
  if (!v) throw notFound("TEMPLATE_NOT_FOUND", "That template no longer exists");
  return render(v.body, await contextFor(req, lead));
}

/**
 * A lead's words before Send (the run screen, Task 4): the version the run planned with, rendered for
 * them; "" for a run in the person's own words. A lead that can't be sent now says why, and nothing
 * changes: Send is what skips it.
 */
export async function itemText(
  req: FastifyRequest,
  id: string,
  position: number,
): Promise<{ text: string; missing: string[] } | { unavailable: string }> {
  const q = await queueRow(req, id);
  const it = await itemAt(req, id, position);
  let lead: LeadRow;
  try {
    lead = await visibleLead(req, it.leadId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { unavailable: WHY.gone };
  }
  const why = whyNot(req, lead);
  if (why) return { unavailable: why };
  if (it.textOverride) return { text: it.textOverride, missing: [] };
  if (!q.templateVersionId) return { text: "", missing: [] };
  return plannedText(req, q.templateVersionId, lead);
}

/**
 * Opens WhatsApp for one lead of the run (spec §5): claims it (one send per item, Review Focus 1), checks
 * the lead again (Review Focus 3), renders the version the run planned with unless the person edited it
 * (Review Focus 5), and goes through 4A's prepare. The run's row is locked for the length of this, so two
 * tabs take turns and the daily cap can't be passed between them.
 */
export async function prepareItem(
  req: FastifyRequest,
  id: string,
  position: number,
  body: { text?: string },
): Promise<{ url: string; text: string } | ({ skipped: string } & Step) | Refused> {
  const q = await queueRow(req, id, true);
  assertRunning(q);
  const it = await itemAt(req, id, position);
  if (it.status === "sending")
    throw new HttpError(409, "ITEM_TAKEN", "That lead is open in another tab", {
      next: await nextPending(req, id, position),
    });
  if (it.status !== "pending") throw conflict("ITEM_DONE", "That lead is done in this run");
  const capped = await capReached(req);
  if (capped) {
    await req.db.update(Q).set({ status: "paused", pausedReason: "daily_cap" }).where(eq(Q.id, id));
    return { refused: capped };
  }
  let lead: LeadRow;
  try {
    lead = await visibleLead(req, it.leadId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    await settle(req, id, position, "skipped", WHY.gone);
    return { skipped: WHY.gone, ...(await step(req, id, position)) };
  }
  const why = whyNot(req, lead);
  if (why) {
    await settle(req, id, position, "skipped", why);
    return { skipped: why, ...(await step(req, id, position)) };
  }
  const own = body.text?.trim() ? body.text : undefined;
  let text = own;
  if (!text) {
    if (!q.templateVersionId) throw badRequest("TEXT_REQUIRED", "Write the message for this lead");
    text = (await plannedText(req, q.templateVersionId, lead)).text;
  }
  await req.db
    .update(I)
    .set({ status: "sending", textOverride: own ?? null })
    .where(and(eq(I.queueId, id), eq(I.position, position), eq(I.status, "pending")));
  const prepared = await prepareMessage(req, lead.id, text, {
    ...(q.templateVersionId ? { templateVersionId: q.templateVersionId } : {}),
    queueId: id,
  });
  return { url: prepared.url, text };
}

/**
 * Sent? answered for one lead (Yes, or Not sent), through 4A's confirm: logged, its follow-up done, its
 * stage moved. Once per lead. A lead lost since WhatsApp opened is skipped with why; the run goes on.
 */
export async function answerItem(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  position: number,
  sent: boolean,
): Promise<Step> {
  await queueRow(req, id, true);
  const it = await itemAt(req, id, position);
  if (it.status === "pending") throw conflict("NOT_OPENED", "WhatsApp hasn't been opened for that lead yet");
  if (it.status !== "sending") throw conflict("ITEM_DONE", "That lead is done in this run");
  await req.db.execute(sql`SAVEPOINT lume_queue_answer`);
  let moved: MoveResult;
  try {
    moved = await confirmSend(req, d, it.leadId, { sent });
    await req.db.execute(sql`RELEASE SAVEPOINT lume_queue_answer`);
  } catch (err) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_queue_answer`);
    await req.db.execute(sql`RELEASE SAVEPOINT lume_queue_answer`);
    if (!(err instanceof HttpError)) throw err;
    await settle(req, id, position, "skipped", err.status === 404 ? WHY.gone : WHY.notYours);
    return step(req, id, position);
  }
  await settle(req, id, position, sent ? "sent" : "not_sent");
  return { ...(await step(req, id, position)), ...(moved.moved || moved.notMoved ? moved : {}) };
}

export async function skipItem(req: FastifyRequest, id: string, position: number): Promise<Step> {
  await queueRow(req, id, true);
  const it = await itemAt(req, id, position);
  if (it.status !== "pending" && it.status !== "sending")
    throw conflict("ITEM_DONE", "That lead is done in this run");
  // A lead that can't be sent any more is skipped for that reason, so the summary says why.
  let reason = "Skipped";
  try {
    reason = whyNot(req, await visibleLead(req, it.leadId)) ?? reason;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    reason = WHY.gone;
  }
  await settle(req, id, position, "skipped", reason);
  return step(req, id, position);
}

export async function pauseQueue(req: FastifyRequest, id: string): Promise<QueueView> {
  const q = await queueRow(req, id, true);
  assertRunning(q);
  await req.db.update(Q).set({ status: "paused", pausedReason: null }).where(eq(Q.id, id));
  await audit(req, { action: "queue.paused", entityType: "send_queue", entityId: id });
  return queueView(req, id);
}

export async function resumeQueue(req: FastifyRequest, id: string): Promise<QueueView | Refused> {
  const q = await queueRow(req, id, true);
  if (q.status === "active") return queueView(req, id);
  if (q.status !== "paused") throw conflict("QUEUE_OVER", "This run is over");
  const capped = await capReached(req);
  if (capped) return { refused: capped };
  await req.db.update(Q).set({ status: "active", pausedReason: null }).where(eq(Q.id, id));
  await audit(req, { action: "queue.resumed", entityType: "send_queue", entityId: id });
  return queueView(req, id);
}

export async function cancelQueue(req: FastifyRequest, id: string): Promise<QueueView> {
  const q = await queueRow(req, id, true);
  if (q.status === "finished" || q.status === "cancelled") throw conflict("QUEUE_OVER", "This run is over");
  await req.db.update(Q).set({ status: "cancelled", finishedAt: new Date() }).where(eq(Q.id, id));
  const view = await queueView(req, id);
  await audit(req, {
    action: "queue.cancelled",
    entityType: "send_queue",
    entityId: id,
    diff: { sent: view.done.sent },
  });
  return view;
}
