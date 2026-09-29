import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, render, type RenderContext } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { doneTask } from "../tasks/service";
import { oneTemplate } from "../templates/service";
import { isFieldVisible, type LeadRow } from "./serialize";
import { recordActivity, visibleLead } from "./service";
import { moveStage } from "./write";

const CONTACT = new Set(["phone", "email", "url", "instagram"]);
export type MoveResult = {
  moved: { stageId: string; stageName: string } | null;
  notMoved?: { code: string; message: string };
};

/** The lead, if the caller may message it (report §11.2 step 2). */
async function sendable(req: FastifyRequest, id: string): Promise<LeadRow> {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  return lead;
}

/**
 * What `render` needs, for this lead as the caller may see it (4A): names, and the values of fields the
 * caller can see that aren't contacts. Never a phone, email, web address or Instagram handle.
 */
export async function contextFor(req: FastifyRequest, lead: LeadRow): Promise<RenderContext> {
  const registry = await loadFieldRegistry(req);
  const fields = registry.defs
    .filter(
      (f) =>
        !f.isCore &&
        !f.archived &&
        !CONTACT.has(f.type) &&
        isFieldVisible({ actor: req.actor!, fields: registry }, f.key),
    )
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options.map((o) => ({ id: o.id, label: o.label })),
    }));
  const custom = Object.fromEntries(
    fields
      .map((f) => [f.key, (lead.custom as Record<string, unknown> | null)?.[f.key]])
      .filter(([, v]) => v !== undefined),
  );
  const [s] = await req.db
    .select({
      name: schema.settings.businessName,
      currency: schema.settings.currency,
      tz: schema.settings.timezone,
    })
    .from(schema.settings);
  const people = await req.db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users);
  const owner = lead.ownerId ? people.find((p) => p.id === lead.ownerId) : undefined;
  return {
    lead: { name: lead.name, custom },
    owner: owner ? { name: owner.name } : null,
    business: { name: s?.name ?? "", currency: s?.currency ?? "", timezone: s?.tz ?? "UTC" },
    fields,
    people,
  };
}

export async function messageContext(req: FastifyRequest, id: string): Promise<RenderContext> {
  return contextFor(req, await sendable(req, id));
}

/** A template (its current words) or your own text, in this lead's words. */
export async function renderFor(
  req: FastifyRequest,
  id: string,
  body: { templateId?: string; text?: string },
): Promise<{ text: string; missing: string[]; versionId?: string }> {
  const lead = await sendable(req, id);
  const ctx = await contextFor(req, lead);
  if (body.templateId) {
    const t = await oneTemplate(req, body.templateId);
    if (!t.usable) throw forbidden("TEMPLATE_NOT_YOURS", "That template isn't one your role can use");
    return { ...render(t.body, ctx), versionId: t.versionId };
  }
  return render(body.text ?? "", ctx);
}

/** A version to send: one a caller's role may use, even if its template was edited or archived since. */
export async function assertVersion(req: FastifyRequest, versionId: string) {
  const [v] = await req.db
    .select({ allowed: schema.messageTemplates.allowedRoleIds })
    .from(schema.templateVersions)
    .innerJoin(schema.messageTemplates, eq(schema.messageTemplates.id, schema.templateVersions.templateId))
    .where(eq(schema.templateVersions.id, versionId));
  if (!v) throw notFound("TEMPLATE_NOT_FOUND", "That template no longer exists");
  const a = req.actor!;
  if (v.allowed.length && !a.isOwner && !v.allowed.some((r) => a.roleIds.includes(r)))
    throw forbidden("TEMPLATE_NOT_YOURS", "That template isn't one your role can use");
}

/**
 * A stage's move after a send or a reply (4A), through moveStage so its rules hold. Refused (a required
 * field missing, a lost reason needed…), it's rolled back on its own and said: the send stays logged.
 */
async function applyMove(req: FastifyRequest, lead: LeadRow, to: string | null): Promise<MoveResult> {
  if (!to || to === lead.stageId) return { moved: null };
  await req.db.execute(sql`SAVEPOINT lume_after_move`);
  try {
    await moveStage(req, lead, { stageId: to });
    await req.db.execute(sql`RELEASE SAVEPOINT lume_after_move`);
    const [s] = await req.db
      .select({ name: schema.stages.name })
      .from(schema.stages)
      .where(eq(schema.stages.id, to));
    return { moved: { stageId: to, stageName: s?.name ?? "" } };
  } catch (err) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_after_move`);
    await req.db.execute(sql`RELEASE SAVEPOINT lume_after_move`);
    if (!(err instanceof HttpError)) throw err;
    return { moved: null, notMoved: { code: err.code, message: err.message } };
  }
}
async function stageMoveOf(req: FastifyRequest, lead: LeadRow, which: "sent" | "reply") {
  const [s] = await req.db
    .select({ sent: schema.stages.afterSentStageId, reply: schema.stages.afterReplyStageId })
    .from(schema.stages)
    .where(eq(schema.stages.id, lead.stageId));
  return (which === "sent" ? s?.sent : s?.reply) ?? null;
}

/**
 * "Sent?" answered (report §11.2 step 4). Once per WhatsApp opened: a second answer changes nothing.
 * Yes: logged, the lead's last message time, the follow-up it came from done, then the stage's move.
 */
export async function confirmSend(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  body: { sent: boolean; taskId?: string },
): Promise<MoveResult> {
  const lead = await sendable(req, id);
  const A = schema.activities;
  const [opened] = await req.db
    .select({ id: A.id, payload: A.payload })
    .from(A)
    .where(and(eq(A.leadId, id), eq(A.userId, req.actor!.userId), eq(A.type, "whatsapp_opened")))
    .orderBy(desc(A.id))
    .limit(1);
  if (!opened) return { moved: null };
  const answered = await req.db
    .select({ id: A.id })
    .from(A)
    .where(
      and(
        eq(A.leadId, id),
        eq(A.userId, req.actor!.userId),
        inArray(A.type, ["whatsapp_confirmed_sent", "whatsapp_not_sent"]),
        sql`${A.id} > ${opened.id}`,
      ),
    )
    .limit(1);
  if (answered.length) return { moved: null };
  const from = (opened.payload ?? {}) as { templateVersionId?: string; taskId?: string };
  if (!body.sent) {
    await recordActivity(req, id, "whatsapp_not_sent");
    return { moved: null };
  }
  await recordActivity(req, id, "whatsapp_confirmed_sent", {
    ...(from.templateVersionId ? { templateVersionId: from.templateVersionId } : {}),
  });
  const now = new Date();
  await req.db
    .update(schema.leads)
    .set({ lastMessageAt: now, lastActivityAt: now })
    .where(eq(schema.leads.id, id));
  // The follow-up it was sent from is done (if it's still open, and the caller may change it).
  const taskId = body.taskId ?? from.taskId;
  if (taskId) {
    await req.db.execute(sql`SAVEPOINT lume_send_task`);
    try {
      await doneTask(req, d, taskId);
      await req.db.execute(sql`RELEASE SAVEPOINT lume_send_task`);
    } catch (err) {
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_send_task`);
      await req.db.execute(sql`RELEASE SAVEPOINT lume_send_task`);
      if (!(err instanceof HttpError)) throw err; // already done or not theirs: the send still counts
    }
  }
  return applyMove(req, await visibleLead(req, id), await stageMoveOf(req, lead, "sent"));
}

/** They replied (report §11.2 step 6): one tap, then the stage's move. It stops "until they reply" repeats. */
export async function logReply(req: FastifyRequest, id: string): Promise<MoveResult> {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  await recordActivity(req, id, "reply_logged");
  const now = new Date();
  await req.db
    .update(schema.leads)
    .set({ lastReplyAt: now, lastActivityAt: now })
    .where(eq(schema.leads.id, id));
  return applyMove(req, await visibleLead(req, id), await stageMoveOf(req, lead, "reply"));
}
