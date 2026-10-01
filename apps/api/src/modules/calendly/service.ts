import { randomBytes } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { CalendlyError, createCalendly } from "./client";
import {
  CALENDLY_DEFAULTS,
  CALENDLY_HEADERS,
  CALENDLY_MAPPING,
  openCalendly,
  sealCalendly,
  type CalendlyConfig,
  type CalendlySettings,
} from "./config";

const S = schema.leadSources;
type Source = typeof S.$inferSelect;

/** Where Calendly posts this instance's bookings. */
export const calendlyAddress = (d: AppDeps, id: string) =>
  `${d.config.publicUrl.replace(/\/$/, "")}/webhooks/calendly/${id}`;
const client = (d: AppDeps, token: string) =>
  createCalendly({
    token,
    ...(d.calendlyEndpoint ? { endpoint: d.calendlyEndpoint } : {}),
    ...(d.calendlyWait ? { sleep: d.calendlyWait } : {}),
  });

/** The one Calendly source this LUME has, if any (archived ones are history). */
export async function liveCalendly(req: FastifyRequest): Promise<Source | undefined> {
  const [s] = await req.db
    .select()
    .from(S)
    .where(and(eq(S.type, "calendly"), ne(S.status, "archived")))
    .orderBy(asc(S.createdAt))
    .limit(1);
  return s;
}

/** What Settings sees: never the token or the signing key. */
async function view(req: FastifyRequest, d: AppDeps, s: Source | undefined) {
  if (!s) return { connected: false as const };
  const c = openCalendly(d.keyring, s.id, s.configEnc!);
  const [who] = s.runAs
    ? await req.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, s.runAs))
    : [];
  return {
    connected: true as const,
    account: c.account,
    scope: c.scope,
    status: s.status,
    settings: c.settings,
    lastEventAt: s.lastEventAt?.toISOString() ?? null,
    lastError: s.status === "needs_attention" ? s.lastError : null,
    /** Whose name new leads and moves are made in (the person who last saved it). */
    runAs: who ?? null,
  };
}

export async function calendlyView(req: FastifyRequest, d: AppDeps) {
  return view(req, d, await liveCalendly(req));
}

/** Calendly's refusals, in LUME's words (the token and Calendly's own text never in them). */
function said(e: unknown): never {
  if (e instanceof CalendlyError) {
    if (e.kind === "token")
      throw badRequest(
        "CALENDLY_TOKEN",
        "Calendly didn't accept that token. In Calendly, open Integrations → API & webhooks, make a new personal access token and paste it here.",
      );
    if (e.kind === "plan")
      throw new HttpError(
        409,
        "CALENDLY_PLAN",
        "Calendly sends bookings to other apps only on its Standard plan or higher. Upgrade the Calendly account, then connect again. Meanwhile LUME can still find meetings in Google Calendar.",
      );
    if (e.kind === "unavailable")
      throw new HttpError(
        503,
        "CALENDLY_UNAVAILABLE",
        "LUME couldn't reach Calendly. Try again in a minute.",
      );
    throw new HttpError(
      409,
      "CALENDLY_REFUSED",
      "Calendly didn't let LUME set this up. Try again, or use another token.",
    );
  }
  throw e;
}

/**
 * Connect (spec §3): the token is checked, a source made for this instance's bookings, and LUME's own
 * subscription asked of Calendly with a new signing key. Nothing is kept if Calendly says no.
 */
export async function connectCalendly(req: FastifyRequest, d: AppDeps, token: string) {
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume.calendly_connect'))`);
  if (await liveCalendly(req))
    throw new HttpError(
      409,
      "CALENDLY_CONNECTED",
      "Calendly is already connected. Disconnect it first to connect another.",
    );
  const calendly = client(d, token.trim());
  const me = await calendly.me().catch(said);
  const [p] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.isDefault, true), sql`${schema.pipelines.archivedAt} IS NULL`));
  const [stage] = p
    ? await req.db
        .select({ id: schema.stages.id })
        .from(schema.stages)
        .where(
          and(
            eq(schema.stages.pipelineId, p.id),
            eq(schema.stages.kind, "open"),
            sql`${schema.stages.archivedAt} IS NULL`,
          ),
        )
        .orderBy(asc(schema.stages.position))
        .limit(1)
    : [];
  if (!p || !stage)
    throw new HttpError(409, "NO_PIPELINE", "LUME needs a pipeline with an open stage first.");
  const [settings] = await req.db
    .select({ country: schema.settings.defaultCountryIso })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const id = newId();
  const signingKey = randomBytes(32).toString("base64url");
  const sub = await calendly
    .subscribe({ url: calendlyAddress(d, id), signingKey, organization: me.organization, user: me.uri })
    .catch(said);
  const rules: Rules = {
    matchOn: ["email", "phone"],
    onMatch: "merge",
    reopenClosedTo: null,
    pipelineId: p.id,
    stageId: stage.id,
    owner: { mode: "unassigned" },
    defaultCountry: settings?.country ?? null,
    noName: "use_contact",
    unknownOwner: "fallback",
    requiredDefaults: {},
  };
  const config: CalendlyConfig = {
    token: token.trim(),
    signingKey,
    subscription: sub.uri,
    scope: sub.scope,
    organization: me.organization,
    user: me.uri,
    account: { name: me.name, email: me.email },
    settings: CALENDLY_DEFAULTS,
  };
  await req.db.insert(S).values({
    id,
    type: "calendly",
    name: "Calendly",
    status: "active",
    createdBy: req.actor!.userId,
    runAs: req.actor!.userId,
    configEnc: sealCalendly(d.keyring, id, config),
    rules,
    mapping: CALENDLY_MAPPING,
    headers: CALENDLY_HEADERS,
  });
  await audit(req, {
    action: "calendly.connected",
    entityType: "lead_source",
    entityId: id,
    diff: { account: me.name, scope: sub.scope },
  });
  return view(req, d, await liveCalendly(req));
}

export async function patchCalendly(req: FastifyRequest, d: AppDeps, p: Partial<CalendlySettings>) {
  const s = await liveCalendly(req);
  if (!s) throw notFound("CALENDLY_NOT_CONNECTED", "Calendly isn't connected.");
  await req.db.execute(sql`SELECT 1 FROM lead_sources WHERE id = ${s.id} FOR UPDATE`);
  const c = openCalendly(d.keyring, s.id, s.configEnc!);
  const settings: CalendlySettings = {
    ...c.settings,
    ...p,
    ...(p.phoneQuestion !== undefined ? { phoneQuestion: p.phoneQuestion?.trim() || null } : {}),
  };
  const mine = can(req.actor!, "leads.import");
  await req.db
    .update(S)
    .set({
      configEnc: sealCalendly(d.keyring, s.id, { ...c, settings }),
      ...(mine ? { runAs: req.actor!.userId } : {}),
      ...(mine && s.status === "needs_attention" && s.attentionCode === "RUN_AS_ACCESS"
        ? { status: "active" as const, attentionCode: null, lastError: null }
        : {}),
    })
    .where(eq(S.id, s.id));
  if (mine) {
    const waiting = await req.db
      .select({ id: schema.webhookEvents.id })
      .from(schema.webhookEvents)
      .where(and(eq(schema.webhookEvents.sourceId, s.id), eq(schema.webhookEvents.status, "queued")));
    if (waiting.length)
      req.afterCommit(() => void Promise.all(waiting.map((w) => d.webhooks?.enqueue(w.id))));
  }
  await audit(req, {
    action: "calendly.settings_changed",
    entityType: "lead_source",
    entityId: s.id,
    diff: {
      createLeads: settings.createLeads,
      rescheduleFollowUp: settings.rescheduleFollowUp,
      phoneQuestion: !!settings.phoneQuestion,
    },
  });
  return view(req, d, await liveCalendly(req));
}

/** Disconnect: LUME's subscription goes (if Calendly answers), the source is archived; leads and meetings stay. */
export async function disconnectCalendly(req: FastifyRequest, d: AppDeps) {
  const s = await liveCalendly(req);
  if (!s) throw notFound("CALENDLY_NOT_CONNECTED", "Calendly isn't connected.");
  const c = openCalendly(d.keyring, s.id, s.configEnc!);
  await client(d, c.token)
    .unsubscribe(c.subscription)
    .catch((err: unknown) =>
      req.log.warn(
        { err: err instanceof Error ? err.message : err },
        "couldn't unsubscribe at Calendly; forgetting it anyway",
      ),
    );
  await req.db.update(S).set({ status: "archived", archivedAt: new Date() }).where(eq(S.id, s.id));
  await audit(req, { action: "calendly.disconnected", entityType: "lead_source", entityId: s.id, diff: {} });
  return { connected: false as const };
}
