import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { givesAway } from "../imports/runner";
import { createDraftFrom, mine, type DraftView } from "../imports/service";
import { prepareStart } from "../imports/start";
import { gridToCsv } from "../sheets/grid";
import { integrationsView } from "../sheets/service";
import { cellsFor, flatten } from "./payload";
import { PRESETS, presetMapping, type Preset } from "./presets";
import { eventContext } from "./process";
import { newSecret, openWebhook, sealWebhook } from "./secret";

const S = schema.leadSources;
const E = schema.webhookEvents;
const I = schema.imports;
type Source = typeof S.$inferSelect;
type Event = typeof E.$inferSelect;
const MAX_WEBHOOKS = 20;

// ——— The module switch (2C spec §2) ———

export async function webhooksOn(req: FastifyRequest): Promise<boolean> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return !!s?.i.webhooks?.enabled;
}

export async function setWebhooksEnabled(req: FastifyRequest, d: AppDeps, enabled: boolean) {
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{webhooks}', ${JSON.stringify({ enabled })}::jsonb) WHERE id = 1`,
  );
  await audit(req, {
    action: enabled ? "integration.enabled" : "integration.disabled",
    entityType: "integration",
    diff: { module: "webhooks" },
  });
  return integrationsView(req, d);
}

async function requireOn(req: FastifyRequest) {
  if (!(await webhooksOn(req)))
    throw new HttpError(
      409,
      "WEBHOOKS_OFF",
      "Webhooks are switched off. Switch them on in Settings → Integrations.",
    );
}
const cannotImport = () => forbidden("CANNOT_IMPORT", "A webhook adds leads, which your role can't do.");

/** A webhook that isn't removed (a draft is one being set up); others are 404. */
async function liveWebhook(req: FastifyRequest, id: string): Promise<Source> {
  const [s] = await req.db
    .select()
    .from(S)
    .where(and(eq(S.id, id), eq(S.type, "webhook")));
  if (!s || s.status === "archived") throw notFound("WEBHOOK_NOT_FOUND", "Webhook not found");
  return s;
}
const addressOf = (d: AppDeps, id: string) => `${d.config.publicUrl.replace(/\/$/, "")}/webhooks/in/${id}`;
const payloadOf = (d: AppDeps, e: Event) =>
  JSON.parse(d.keyring.decrypt(e.payloadEnc!, eventContext(e.sourceId, e.eventKey))) as Record<
    string,
    unknown
  >;
/** Queue these events for processing once this request's transaction has committed. */
function requeue(req: FastifyRequest, d: AppDeps, ids: number[]) {
  if (ids.length) req.afterCommit(() => void Promise.all(ids.map((id) => d.webhooks?.enqueue(id))));
}

// ——— What the screens see (spec §7) ———

export type WebhookView = Awaited<ReturnType<typeof webhookView>>;

async function webhookView(req: FastifyRequest, d: AppDeps, s: Source) {
  const cfg = openWebhook(d.keyring, s.id, s.configEnc!);
  const { rows } = await req.db.execute<{
    today: number;
    all: number;
    created: number;
    merged: number;
    problems: number;
    run_as: string | null;
  }>(sql`
    SELECT
      count(e.id) FILTER (WHERE e.status <> 'test' AND e.received_at >= (date_trunc('day', now() AT TIME ZONE st.timezone) AT TIME ZONE st.timezone))::int AS today,
      count(e.id) FILTER (WHERE e.status <> 'test')::int AS all,
      count(e.id) FILTER (WHERE e.result = 'created')::int AS created,
      count(e.id) FILTER (WHERE e.result = 'merged')::int AS merged,
      count(e.id) FILTER (WHERE e.status = 'error')::int AS problems,
      (SELECT name FROM users WHERE id = ${s.runAs}) AS run_as
    FROM settings st LEFT JOIN webhook_events e ON e.source_id = ${s.id}
    WHERE st.id = 1`);
  const c = rows[0]!;
  return {
    id: s.id,
    name: s.name,
    status: s.status as "draft" | "active" | "paused" | "needs_attention",
    attention:
      s.status === "needs_attention" ? { code: s.attentionCode ?? "", message: s.lastError ?? "" } : null,
    preset: cfg.preset,
    mode: cfg.mode,
    address: addressOf(d, s.id),
    lastEventAt: s.lastEventAt?.toISOString() ?? null,
    eventsToday: c.today,
    eventsAllTime: c.all,
    created: c.created,
    merged: c.merged,
    problems: c.problems,
    rejected: s.rejected,
    lastRejectedReason: s.lastRejectedReason,
    newColumns: s.newColumns,
    runAs: s.runAs && c.run_as ? { id: s.runAs, name: c.run_as } : null,
  };
}

export async function listWebhooks(req: FastifyRequest, d: AppDeps) {
  const rows = await req.db
    .select()
    .from(S)
    .where(and(eq(S.type, "webhook"), inArray(S.status, ["draft", "active", "paused", "needs_attention"])))
    .orderBy(asc(S.createdAt));
  // One after another: they share this request's connection.
  const sources = [];
  for (const s of rows) sources.push(await webhookView(req, d, s));
  return { sources };
}

export async function getWebhook(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveWebhook(req, id);
  const events = await req.db
    .select({ id: E.id, receivedAt: E.receivedAt, status: E.status, result: E.result, leadId: E.leadId })
    .from(E)
    .where(and(eq(E.sourceId, id), sql`${E.status} <> 'test'`))
    .orderBy(desc(E.id))
    .limit(20);
  const problemEvents = await req.db
    .select({ id: E.id, receivedAt: E.receivedAt, problems: E.problems })
    .from(E)
    .where(and(eq(E.sourceId, id), eq(E.status, "error")))
    .orderBy(asc(E.id))
    .limit(100);
  return {
    ...(await webhookView(req, d, s)),
    events: events.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString() })),
    problemEvents: problemEvents.map((p) => ({
      id: p.id,
      receivedAt: p.receivedAt.toISOString(),
      problems: p.problems.map(({ code, message }) => ({ code, message })),
    })),
  };
}

// ——— Setting one up (spec §6) ———

export async function createWebhook(req: FastifyRequest, d: AppDeps, body: { preset: Preset; name: string }) {
  await requireOn(req);
  if (PRESETS[body.preset].hidden && !d.manychatPreset)
    throw badRequest("PRESET_HIDDEN", "That kind of webhook isn't available yet.");
  const { rows } = await req.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM lead_sources WHERE type = 'webhook' AND status <> 'archived'`,
  );
  if (rows[0]!.n >= MAX_WEBHOOKS)
    throw new HttpError(
      409,
      "TOO_MANY_WEBHOOKS",
      `LUME takes up to ${MAX_WEBHOOKS} webhooks. Remove one first.`,
    );
  const id = newId();
  const mode = PRESETS[body.preset].mode;
  const secret = newSecret();
  await req.db.insert(S).values({
    id,
    type: "webhook",
    name: body.name.trim(),
    status: "draft",
    createdBy: req.actor!.userId,
    runAs: req.actor!.userId,
    configEnc: sealWebhook(d.keyring, id, { mode, secret, preset: body.preset }),
  });
  const s = await liveWebhook(req, id);
  // The one time the secret leaves LUME: the sender needs it, and LUME never shows it again.
  return { source: await webhookView(req, d, s), address: addressOf(d, id), secret, mode };
}

async function newestEvent(req: FastifyRequest, id: string, onlyTest: boolean) {
  const [e] = await req.db
    .select()
    .from(E)
    .where(and(eq(E.sourceId, id), onlyTest ? eq(E.status, "test") : isNotNull(E.payloadEnc)))
    .orderBy(desc(E.id))
    .limit(1);
  return e && e.payloadEnc ? e : null;
}

export async function testPost(req: FastifyRequest, d: AppDeps, id: string) {
  await liveWebhook(req, id);
  const e = await newestEvent(req, id, true);
  if (!e) return null;
  const { cells, unmappable } = flatten(payloadOf(d, e));
  return { paths: [...cells.keys()], unmappable, receivedAt: e.receivedAt.toISOString() };
}

/**
 * The 2A draft for this webhook: its paths are the columns and a post is the one row. A new webhook
 * reads its test post with the preset's mapping; an edit keeps the saved paths first (so the saved
 * mapping still lines up), then any new ones from the newest post.
 */
export async function createWebhookDraft(req: FastifyRequest, d: AppDeps, id: string): Promise<DraftView> {
  await requireOn(req);
  if (!can(req.actor!, "leads.import")) throw cannotImport();
  const s = await liveWebhook(req, id);
  const editing = s.status !== "draft";
  const e = await newestEvent(req, id, !editing);
  // A new webhook needs its test post. An edit can go without one (its posts may all be past the 30 days
  // their payloads are kept): its saved paths are the columns, with no row to preview (final review, 7).
  if (!e && !editing)
    throw new HttpError(
      409,
      "NO_TEST_POST",
      "LUME hasn't had a post to this webhook yet. Send a test post first.",
    );
  const cells = e ? flatten(payloadOf(d, e)).cells : new Map<string, string>();
  const saved = editing ? s.headers : [];
  const paths = [...saved, ...[...cells.keys()].filter((p) => !saved.includes(p))];
  const cfg = openWebhook(d.keyring, id, s.configEnc!);
  // Drafts made before (going back a step) are replaced by this one.
  await req.db.delete(I).where(and(eq(I.sourceId, id), eq(I.status, "draft"), eq(I.kind, "webhook")));
  return createDraftFrom(req, d, {
    bytes: Buffer.from(gridToCsv(e ? [paths, cellsFor(paths, cells)] : [paths])),
    fileName: s.name,
    kind: "webhook",
    sourceId: id,
    targetSourceId: id,
    ...(editing
      ? { mapping: s.mapping as Mapping, rules: s.rules as Rules }
      : { suggest: (headers, fields) => presetMapping(cfg.preset, headers, fields) }),
  });
}

export async function saveWebhook(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  body: { importId: string; keepTest: boolean },
) {
  await requireOn(req);
  const actor = req.actor!;
  if (!can(actor, "leads.import")) throw cannotImport();
  await req.db.execute(sql`SELECT 1 FROM imports WHERE id = ${body.importId} FOR UPDATE`);
  const imp = await mine(req, body.importId);
  if (imp.kind !== "webhook" || imp.status !== "draft" || imp.targetSourceId !== id)
    throw new HttpError(409, "NOT_DRAFT", "This webhook's setup was already saved.");
  const s = await liveWebhook(req, id);
  const { file, mapping, rules, columnSettings } = await prepareStart(req, d, imp, {
    keepCreatingTags: true,
  });
  if (givesAway(rules, mapping, actor) && !can(actor, "leads.assign"))
    throw forbidden("CANNOT_ASSIGN", "This webhook gives leads to other people, which your role can't do.");
  const first = s.status === "draft";
  const clears =
    s.status === "needs_attention" && ["COLUMNS_CHANGED", "RUN_AS_ACCESS"].includes(s.attentionCode ?? "");
  await req.db
    .update(S)
    .set({
      mapping,
      rules,
      columnSettings,
      headers: file.headers,
      runAs: actor.userId,
      configVersion: s.configVersion + 1,
      newColumns: [],
      ...(first || clears ? { status: "active", attentionCode: null, lastError: null } : {}),
    })
    .where(eq(S.id, id));
  await req.db.delete(I).where(eq(I.id, imp.id));

  // The test post: the first lead, or set aside. Posts waiting through a pause or a problem go through now.
  const tests = await req.db
    .select({ id: E.id })
    .from(E)
    .where(and(eq(E.sourceId, id), eq(E.status, "test")))
    .orderBy(desc(E.id));
  const [keep, ...rest] = tests.map((t) => t.id);
  if (keep !== undefined)
    await req.db
      .update(E)
      .set({ status: body.keepTest ? "queued" : "dismissed", ...(body.keepTest ? {} : { payloadEnc: null }) })
      .where(eq(E.id, keep));
  if (rest.length)
    await req.db.update(E).set({ status: "dismissed", payloadEnc: null }).where(inArray(E.id, rest));
  const waiting = await req.db
    .select({ id: E.id })
    .from(E)
    .where(and(eq(E.sourceId, id), eq(E.status, "queued")));
  requeue(
    req,
    d,
    waiting.map((w) => w.id),
  );

  await audit(req, {
    action: first ? "webhook.connected" : "webhook.mapping_changed",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
  return webhookView(req, d, await liveWebhook(req, id));
}

// ——— Looking after one ———

export async function patchWebhook(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  p: { name?: string; paused?: boolean },
) {
  const s = await liveWebhook(req, id);
  const set: Partial<typeof S.$inferInsert> = {};
  if (p.name !== undefined) set.name = p.name.trim();
  if (p.paused === true && (s.status === "active" || s.status === "needs_attention")) set.status = "paused";
  if (p.paused === false && s.status === "paused") set.status = "active";
  if (Object.keys(set).length) await req.db.update(S).set(set).where(eq(S.id, id));
  if (set.status === "active") {
    const waiting = await req.db
      .select({ id: E.id })
      .from(E)
      .where(and(eq(E.sourceId, id), eq(E.status, "queued")));
    requeue(
      req,
      d,
      waiting.map((w) => w.id),
    );
  }
  if (set.status || set.name)
    await audit(req, {
      action:
        set.status === "paused"
          ? "webhook.paused"
          : set.status === "active"
            ? "webhook.resumed"
            : "webhook.renamed",
      entityType: "lead_source",
      entityId: id,
      diff: { name: set.name ?? s.name },
    });
  return webhookView(req, d, await liveWebhook(req, id));
}

/** A new secret; the old one stops working the moment this commits. */
export async function rotateSecret(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveWebhook(req, id);
  const cfg = openWebhook(d.keyring, id, s.configEnc!);
  const secret = newSecret();
  await req.db
    .update(S)
    .set({ configEnc: sealWebhook(d.keyring, id, { ...cfg, secret }) })
    .where(eq(S.id, id));
  await audit(req, {
    action: "webhook.secret_rotated",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
  return { secret };
}

export async function retryEvent(req: FastifyRequest, d: AppDeps, id: string, eventId: number) {
  await liveWebhook(req, id);
  const again = await req.db
    .update(E)
    .set({ status: "queued", problems: [] })
    .where(and(eq(E.id, eventId), eq(E.sourceId, id), eq(E.status, "error")))
    .returning({ id: E.id });
  if (!again.length) throw notFound("EVENT_NOT_FOUND", "That problem post isn't there any more.");
  requeue(req, d, [eventId]);
}

export async function dismissEvent(req: FastifyRequest, id: string, eventId: number) {
  const s = await liveWebhook(req, id);
  const gone = await req.db
    .update(E)
    .set({ status: "dismissed", payloadEnc: null })
    .where(and(eq(E.id, eventId), eq(E.sourceId, id), eq(E.status, "error")))
    .returning({ id: E.id });
  if (!gone.length) throw notFound("EVENT_NOT_FOUND", "That problem post isn't there any more.");
  await audit(req, {
    action: "webhook.event_dismissed",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
}

/** Removed is archived (as a sheet, 2B A12): its leads keep it, and posts to it are refused. */
export async function removeWebhook(req: FastifyRequest, id: string) {
  const s = await liveWebhook(req, id);
  await req.db.update(S).set({ status: "archived", archivedAt: new Date() }).where(eq(S.id, id));
  await req.db.delete(I).where(and(eq(I.sourceId, id), eq(I.status, "draft")));
  await audit(req, {
    action: "webhook.removed",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
}
