import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, newId, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import type { LeadRow } from "./serialize";
import { recordActivity, visibleLead } from "./service";

const L = schema.leads;

/** Is a core or custom field filled on this lead? (stage required-field rule, report §14) */
function hasValue(lead: LeadRow, key: string): boolean {
  const core: Record<string, unknown> = {
    name: lead.name,
    phone: lead.phoneE164 ?? lead.phoneRaw,
    email: lead.email,
    instagram: lead.instagramHandle,
    owner: lead.ownerId,
    stage: lead.stageId,
    source: lead.sourceId,
    value: lead.value,
    lead_created_at: lead.leadCreatedAt,
  };
  const v = key in core ? core[key] : lead.custom?.[key];
  return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
}

export async function moveStage(
  req: FastifyRequest,
  lead: LeadRow,
  input: { stageId: string; lostReasonId?: string; lostNote?: string },
): Promise<LeadRow> {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.change_stage", lead.ownerId)) throw forbidden();
  const [target] = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.id, input.stageId), isNull(schema.stages.archivedAt)));
  if (!target) throw badRequest("UNKNOWN_STAGE", "That stage doesn't exist");
  if (target.id === lead.stageId && target.kind !== "lost") return lead;

  const fields = await loadFieldRegistry(req);
  const missing = target.requiredFieldIds
    .map((id) => fields.byId.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d && !d.archived)
    .filter((d) => !hasValue(lead, d.key))
    .map((d) => d.key);
  if (missing.length)
    throw new HttpError(422, "REQUIRED_FIELDS", "Fill these in before moving to this stage", {
      fields: missing,
    });

  const now = new Date();
  const set: Partial<typeof L.$inferInsert> = {
    stageId: target.id,
    pipelineId: target.pipelineId,
    stageEnteredAt: now,
    lastActivityAt: now,
  };
  if (target.kind === "lost") {
    if (!input.lostReasonId) throw badRequest("LOST_REASON_REQUIRED", "Pick a reason this lead was lost");
    const [reason] = await req.db
      .select({ id: schema.lostReasons.id })
      .from(schema.lostReasons)
      .where(and(eq(schema.lostReasons.id, input.lostReasonId), isNull(schema.lostReasons.archivedAt)));
    if (!reason) throw badRequest("UNKNOWN_LOST_REASON", "That lost reason doesn't exist");
    Object.assign(set, {
      lostAt: now,
      wonAt: null,
      lostReasonId: reason.id,
      lostNote: input.lostNote ?? null,
    });
  } else if (target.kind === "won") {
    Object.assign(set, { wonAt: now, lostAt: null, lostReasonId: null, lostNote: null });
  } else {
    Object.assign(set, { wonAt: null, lostAt: null, lostReasonId: null, lostNote: null });
  }

  await req.db.insert(schema.leadStageHistory).values({
    leadId: lead.id,
    fromStageId: lead.stageId,
    toStageId: target.id,
    pipelineId: target.pipelineId,
    changedBy: actor.userId,
  });
  await recordActivity(req, lead.id, "stage_changed", { from: lead.stageId, to: target.id });
  await req.db
    .update(L)
    .set({ ...set, version: sql`${L.version} + 1` })
    .where(eq(L.id, lead.id));
  await audit(req, {
    action: "lead.stage",
    entityType: "lead",
    entityId: lead.id,
    diff: { from: lead.stageId, to: target.id },
  });
  return visibleLead(req, lead.id);
}

/**
 * Report §7.4 #4. History and activity are written *before* the owner changes: once it does, the caller
 * may no longer see the lead (and RLS would refuse the child rows).
 */
export async function assignLead(
  req: FastifyRequest,
  lead: LeadRow,
  input: { ownerId: string | null; reason?: string },
): Promise<{ visible: boolean }> {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.assign", lead.ownerId)) throw forbidden();
  if (input.ownerId === lead.ownerId) return { visible: true };
  if (input.ownerId === null) {
    if (!actor.isOwner && scopeOf(actor, "leads.assign") !== "all")
      throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't leave leads unassigned");
  } else {
    const [u] = await req.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, input.ownerId), eq(schema.users.status, "active")));
    if (!u) throw badRequest("UNKNOWN_USER", "That person doesn't exist or is disabled");
  }
  await req.db.insert(schema.leadAssignmentHistory).values({
    leadId: lead.id,
    fromUserId: lead.ownerId,
    toUserId: input.ownerId,
    changedBy: actor.userId,
    reason: input.reason ?? null,
  });
  await recordActivity(req, lead.id, "assigned", { from: lead.ownerId, to: input.ownerId });
  // Postgres checks an UPDATE's new row against the read policy; allow exactly this lead to leave the
  // caller's scope (lume_handoff_lead, 0010_lead_rls.sql), then withdraw the allowance at once.
  await req.db.execute(sql`SELECT set_config('lume.handoff_lead', ${lead.id}, true)`);
  await req.db
    .update(L)
    .set({ ownerId: input.ownerId, lastActivityAt: new Date(), version: sql`${L.version} + 1` })
    .where(eq(L.id, lead.id));
  await req.db.execute(sql`SELECT set_config('lume.handoff_lead', '', true)`);
  await audit(req, {
    action: "lead.assign",
    entityType: "lead",
    entityId: lead.id,
    diff: { from: lead.ownerId, to: input.ownerId },
  });
  return { visible: canOnRecord(actor, "leads.view", input.ownerId) };
}

export async function addNote(req: FastifyRequest, lead: LeadRow, body: string) {
  if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  const id = newId();
  await req.db
    .insert(schema.activities)
    .values({ id, leadId: lead.id, userId: req.actor!.userId, type: "note", payload: { body } });
  await req.db.update(L).set({ lastActivityAt: new Date() }).where(eq(L.id, lead.id));
  return { activity: { id, type: "note", payload: { body } } };
}

export async function listActivities(
  req: FastifyRequest,
  lead: LeadRow,
  q: { cursor?: string; limit: number },
) {
  const A = schema.activities;
  const where = q.cursor ? and(eq(A.leadId, lead.id), lt(A.id, q.cursor)) : eq(A.leadId, lead.id);
  // Activity ids are UUID v7 (time-ordered), so id order is occurrence order for app-written rows.
  const rows = await req.db
    .select({
      id: A.id,
      type: A.type,
      payload: A.payload,
      occurredAt: A.occurredAt,
      userId: A.userId,
      userName: schema.users.name,
    })
    .from(A)
    .leftJoin(schema.users, eq(schema.users.id, A.userId))
    .where(where)
    .orderBy(desc(A.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      payload: r.payload,
      occurredAt: r.occurredAt,
      user: r.userId ? { id: r.userId, name: r.userName } : null,
    })),
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}
