import {
  canOnRecord,
  costOf,
  firstNameOf,
  newId,
  normalizePhone,
  paramsFor,
  render,
  VARIABLES,
  type MetaCategory,
  type TemplateCost,
} from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { HttpError, badRequest } from "../../http/errors";
import { contextFor, sendable } from "../leads/sending";
import type { LeadRow } from "../leads/serialize";
import { readMessaging } from "../settings/messaging";
import { notePaidUse, paidLimit, paidLimitError, paidUseIn } from "./paid";
import { replyOn, type SendLimiter } from "./send";
import { messagesOf, type ThreadMessage } from "./thread";
import { personSent } from "../autopilot/lead-events";

const S = schema.whatsappTemplateSubmissions;
const T = schema.messageTemplates;
const V = schema.templateVersions;
const N = schema.whatsappNumbers;
const O = schema.whatsappOutbox;

export type TemplateOption = {
  submissionId: string;
  name: string;
  category: MetaCategory;
  /** The template in this lead's words, as they'd read it. */
  preview: string;
  /** What this lead has no value for (by the names people pick variables by): it can't go until they're filled. */
  missing: string[];
  /** What WhatsApp charges for it, about; null where LUME has no rate. */
  cost: TemplateCost | null;
};
export type TemplateState = {
  number: { id: string; display: string } | null;
  options: TemplateOption[];
  reason: string | null;
} | null;

const conflict = (code: string, message: string) => new HttpError(409, code, message);

/**
 * The number a template goes from (W3b-2): the lead's owner's own number, else the business's first, else the first
 * connected at all. A template reaches a lead who never wrote, so no conversation picks it.
 */
async function numberFor(req: FastifyRequest, lead: LeadRow) {
  const active = await req.db
    .select({ id: N.id, display: N.displayPhone, waba: N.wabaId, owner: N.ownerUserId })
    .from(N)
    .where(eq(N.status, "active"))
    .orderBy(asc(N.id));
  return (
    (lead.ownerId ? active.find((n) => n.owner === lead.ownerId) : undefined) ??
    active.find((n) => n.owner === null) ??
    active[0] ??
    null
  );
}

/** Approved, current templates on this account this person may use, for this lead. */
export async function approvedFor(req: FastifyRequest, waba: string, lead: LeadRow) {
  const rows = await req.db
    .select({
      id: S.id,
      name: T.name,
      category: S.category,
      tokens: S.tokens,
      metaName: S.metaName,
      language: S.language,
      body: V.body,
      allowed: T.allowedRoleIds,
      templateId: T.id,
    })
    .from(S)
    .innerJoin(V, eq(V.id, S.templateVersionId))
    .innerJoin(T, eq(T.id, V.templateId))
    .where(and(eq(S.wabaId, waba), eq(S.status, "approved"), isNull(T.archivedAt)))
    .orderBy(asc(T.position), asc(T.name), desc(V.createdAt));
  const a = req.actor!;
  // The newest approved words of each template and language: an edit waits for its own approval while the approved
  // words keep going (W3b-2 Review Focus 1), and the edit itself never goes unapproved.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.templateId}:${r.language}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      (r.allowed.length === 0 || a.isOwner || r.allowed.some((x) => a.roleIds.includes(x))) &&
      !(lead.whatsappMarketingOffAt && r.category === "MARKETING")
    );
  });
}

/** The labels people pick variables by ("Meeting date"), for what's missing. */
export const labelsOf = (fields: { key: string; type: never; label?: string }[]) =>
  new Map(VARIABLES(fields).map((v) => [v.token, v.label]));

/**
 * For the reply box outside the 24 hours (W3b-2 Task 6): the number it would go from and the approved templates to
 * choose, each in this lead's words with what's missing and what it costs. Null when there's nothing to offer here
 * (replying from LUME off, or this person can't message the lead).
 */
export async function templateState(req: FastifyRequest, d: AppDeps, lead: LeadRow): Promise<TemplateState> {
  if (!(await replyOn(req, d)) || !canOnRecord(req.actor!, "messages.send", lead.ownerId)) return null;
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    return { number: null, options: [], reason: "This lead has no WhatsApp number." };
  const n = await numberFor(req, lead);
  if (!n) return { number: null, options: [], reason: "Connect a WhatsApp number first." };
  const ctx = await contextFor(req, lead);
  const labels = labelsOf(ctx.fields as never);
  const country = normalizePhone(lead.phoneE164).countryIso;
  const options = (await approvedFor(req, n.waba, lead)).map((r) => ({
    submissionId: r.id,
    name: r.name,
    category: r.category,
    preview: render(r.body, ctx).text,
    missing: paramsFor(r.tokens, ctx).missing.map((t) => labels.get(t) ?? t),
    cost: costOf(country, r.category),
  }));
  return { number: { id: n.id, display: n.display }, options, reason: null };
}

/**
 * Send an approved template to a lead (W3b-2 Task 6): every check of a reply except the 24 hours, plus approved on
 * this number's account, the current words, every value there, the month's limit and the person's pace. Queued like
 * any reply from LUME, so statuses, retries and "counts as a send" are W3a's.
 */
export async function sendTemplate(
  req: FastifyRequest,
  d: AppDeps,
  limiter: SendLimiter,
  leadId: string,
  body: { submissionId: string; clientKey: string },
  /** LUME AI's, in a run (Autopilot A2): the same checks, marked as LUME AI's, paced by the run, not this limiter. */
  auto?: { runId: string },
): Promise<{ message: ThreadMessage }> {
  const me = req.actor!.userId;
  const again = async () => {
    const [prior] = await req.db
      .select({ activityId: O.activityId, leadId: O.leadId })
      .from(O)
      .where(and(eq(O.userId, me), eq(O.clientKey, body.clientKey)));
    if (!prior?.activityId) return null;
    if (prior.leadId !== leadId)
      throw badRequest("KEY_REUSED", "That message was already sent to another lead.");
    const [m] = await messagesOf(req, [prior.activityId]);
    return m ? { message: m } : null;
  };
  const prior = await again();
  if (prior) return prior;

  if (!(await replyOn(req, d)))
    throw conflict(
      "REPLY_OFF",
      "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
    );
  const lead = await sendable(req, leadId);
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    throw conflict("NO_WHATSAPP", "This lead has no WhatsApp number.");
  const number = await numberFor(req, lead);
  if (!number) throw conflict("NO_NUMBER", "Connect a WhatsApp number first.");

  const [sub] = await req.db
    .select({ id: S.id, waba: S.wabaId, status: S.status, category: S.category })
    .from(S)
    .where(eq(S.id, body.submissionId));
  if (!sub) throw conflict("TEMPLATE_NOT_HERE", "That template isn't approved for WhatsApp here.");
  if (sub.category === "MARKETING" && lead.whatsappMarketingOffAt)
    throw conflict("MARKETING_OFF", "This person turned off marketing messages from you on WhatsApp.");
  const option = (await approvedFor(req, number.waba, lead)).find((r) => r.id === sub.id);
  if (!option)
    throw conflict(
      "TEMPLATE_NOT_HERE",
      sub.waba === number.waba
        ? "That template isn't approved as it's written now. Submit it again."
        : `That template isn't approved for ${number.display}'s WhatsApp account.`,
    );

  const ctx = await contextFor(req, lead);
  const { values, missing } = paramsFor(option.tokens, ctx);
  if (missing.length) {
    const labels = labelsOf(ctx.fields as never);
    const words = missing.map((t) => labels.get(t) ?? t).join(", ");
    const who = firstNameOf(lead.name ?? "") || "This lead";
    throw new HttpError(
      422,
      "MISSING_VALUES",
      `${who} has no ${words} yet, so this template can't go. Choose another, or add it first.`,
    );
  }

  // The month's limit: counted in the database, every lead's, and held for this request so two at once can't both
  // take the last one.
  const settings = await readMessaging(req);
  const limit = paidLimit(req.server.licence.view().plan, settings);
  let used = 0;
  const tz = await businessZone(req);
  if (limit !== null) {
    await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume.whatsapp_paid'))`);
    used = await paidUseIn(req, d.clock(), tz);
    if (used >= limit) throw paidLimitError(used, limit);
  }

  const verdict = auto ? { ok: true as const } : limiter.take(me);
  if (!verdict.ok)
    throw new HttpError(429, "TOO_MANY", "That's a lot of messages at once. Wait a minute and send again.", {
      retryAfterSec: verdict.retryAfterSec,
    });

  const text = render(option.body, ctx).text;
  const cost = costOf(normalizePhone(lead.phoneE164).countryIso, option.category);
  const outboxId = newId();
  const activityId = newId();
  await req.db.execute(sql`SAVEPOINT lume_template`);
  try {
    await req.db.insert(O).values({
      id: outboxId,
      leadId: lead.id,
      numberId: number.id,
      userId: me,
      activityId,
      clientKey: body.clientKey,
      text,
      submissionId: option.id,
      params: values,
      // WhatsApp charges every template since 2026-10-01, inside the 24 hours too.
      paid: true,
      cost: cost ? String(cost.amount) : null,
      costCurrency: cost?.currency ?? null,
      status: "queued",
      // On LUME's clock, as the month's count reads it.
      createdAt: d.clock(),
      autopilotRunId: auto?.runId ?? null,
    });
    await req.db.execute(sql`RELEASE SAVEPOINT lume_template`);
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_template`);
    if ((e as { code?: string }).code !== "23505") throw e;
    const first = await again();
    if (first) return first;
    throw e;
  }
  await req.db.insert(schema.activities).values({
    id: activityId,
    leadId: lead.id,
    userId: me,
    type: "whatsapp_sent",
    occurredAt: d.clock(),
    payload: {
      text,
      numberId: number.id,
      outboxId,
      ...(auto ? { via: "ai_autopilot", runId: auto.runId } : { via: "lume" }),
      template: { name: option.name },
    },
  });
  // A person messaging a lead in a LUME AI run takes it (Autopilot A2, §3).
  if (!auto) await personSent(req, lead.id);
  req.afterCommit(() => {
    void d.whatsapp?.enqueueSend(outboxId);
    if (limit !== null)
      void notePaidUse(d.jobPool ?? d.pool, d.clock(), tz, used + 1, limit).catch((err: unknown) =>
        req.log.warn({ err }, "couldn't check this month's paid WhatsApp messages"),
      );
  });
  const [message] = await messagesOf(req, [activityId]);
  return { message: message! };
}

async function businessZone(req: FastifyRequest): Promise<string> {
  const [s] = await req.db
    .select({ tz: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return s?.tz ?? "UTC";
}
