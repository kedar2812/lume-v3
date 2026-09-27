import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import type { LeadRow } from "./serialize";

const L = schema.leads;

export async function recordActivity(
  req: FastifyRequest,
  leadId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  await req.db
    .insert(schema.activities)
    .values({ id: newId(), leadId, userId: req.actor!.userId, type, payload });
}

export type NewLead = {
  pipelineId: string;
  stageId: string;
  ownerId: string | null;
  name: string;
  contact: {
    phoneRaw: string | null;
    phoneE164: string | null;
    phoneCountryIso: string | null;
    phoneStatus: "valid" | "needs_country" | "invalid" | "missing";
    email: string | null;
    instagramHandle: string | null;
  };
  value: number | null;
  productId: string | null;
  leadCreatedAt: string | null;
  custom: Record<string, unknown>;
  tagIds: string[];
  sourceId: string | null;
  lostReasonId: string | null;
  closedAt: Date | null;
  stageKind: "open" | "won" | "lost";
  stageEnteredAt: Date;
  activity: { type: string; payload: Record<string, unknown> };
  assignReason: "created" | "imported";
};

/** The one path that creates a lead: the lead, its tags, its first stage and owner in history, and its first activity. */
export async function insertLead(req: FastifyRequest, lead: NewLead): Promise<string> {
  const id = newId();
  const actorId = req.actor!.userId;
  await req.db.insert(L).values({
    id,
    pipelineId: lead.pipelineId,
    stageId: lead.stageId,
    ownerId: lead.ownerId,
    name: lead.name,
    ...lead.contact,
    value: lead.value,
    currency: null, // always the business currency
    productId: lead.productId,
    leadCreatedAt: lead.leadCreatedAt,
    custom: Object.fromEntries(Object.entries(lead.custom).filter(([, v]) => v !== null && v !== undefined)),
    sourceId: lead.sourceId,
    lostReasonId: lead.stageKind === "lost" ? lead.lostReasonId : null,
    wonAt: lead.stageKind === "won" ? lead.closedAt : null,
    lostAt: lead.stageKind === "lost" ? lead.closedAt : null,
    createdBy: actorId,
    lastActivityAt: new Date(),
    stageEnteredAt: lead.stageEnteredAt,
  });
  if (lead.tagIds.length)
    await req.db
      .insert(schema.leadTags)
      .values([...new Set(lead.tagIds)].map((tagId) => ({ leadId: id, tagId })));
  await req.db.insert(schema.leadStageHistory).values({
    leadId: id,
    fromStageId: null,
    toStageId: lead.stageId,
    pipelineId: lead.pipelineId,
    changedBy: actorId,
  });
  if (lead.ownerId)
    await req.db.insert(schema.leadAssignmentHistory).values({
      leadId: id,
      fromUserId: null,
      toUserId: lead.ownerId,
      changedBy: actorId,
      reason: lead.assignReason,
    });
  await recordActivity(req, id, lead.activity.type, lead.activity.payload);
  return id;
}

export type MergeFill = {
  phone?: NewLead["contact"];
  email?: string;
  instagram?: string;
  value?: number;
  leadCreatedAt?: string;
  ownerId?: string;
  custom?: Record<string, unknown>;
  tagIds?: string[];
  reopenTo?: { stageId: string };
};

const empty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Spec §6.9: what a merge fills — only empty fields; never the name, an existing phone, owner or origin date. */
export function mergeFill(
  lead: LeadRow,
  draft: {
    contact: NewLead["contact"];
    value: number | null;
    leadCreatedAt: string | null;
    ownerId: string | null;
    custom: Record<string, unknown>;
    tagIds: string[];
  },
  existingTagIds: string[],
  reopenTo: string | null,
): { fill: MergeFill; filled: string[] } {
  const fill: MergeFill = {};
  const filled: string[] = [];
  if (lead.phoneStatus === "missing" && draft.contact.phoneStatus !== "missing") {
    fill.phone = draft.contact;
    filled.push("phone");
  }
  if (empty(lead.email) && draft.contact.email) {
    fill.email = draft.contact.email;
    filled.push("email");
  }
  if (empty(lead.instagramHandle) && draft.contact.instagramHandle) {
    fill.instagram = draft.contact.instagramHandle;
    filled.push("instagram");
  }
  if (lead.value === null && draft.value !== null) {
    fill.value = draft.value;
    filled.push("value");
  }
  if (lead.leadCreatedAt === null && draft.leadCreatedAt) {
    fill.leadCreatedAt = draft.leadCreatedAt;
    filled.push("date");
  }
  if (lead.ownerId === null && draft.ownerId) {
    fill.ownerId = draft.ownerId;
    filled.push("owner");
  }
  const custom: Record<string, unknown> = {};
  const current = (lead.custom ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(draft.custom))
    if (!empty(v) && empty(current[k])) {
      custom[k] = v;
      filled.push(k);
    }
  if (Object.keys(custom).length) fill.custom = custom;
  const newTags = draft.tagIds.filter((t) => !existingTagIds.includes(t));
  if (newTags.length) {
    fill.tagIds = newTags;
    filled.push("tags");
  }
  if (reopenTo && (lead.wonAt || lead.lostAt)) fill.reopenTo = { stageId: reopenTo };
  return { fill, filled };
}

/** Applies a merge: one update (version + 1), the new tags, a reopen with its stage history, and the activity. */
export async function mergeIntoLead(
  req: FastifyRequest,
  lead: LeadRow,
  fill: MergeFill,
  activity: { type: string; payload: Record<string, unknown> },
) {
  const actorId = req.actor!.userId;
  const set: Record<string, unknown> = {
    version: sql`${L.version} + 1`,
    updatedAt: new Date(),
    lastActivityAt: new Date(),
  };
  if (fill.phone)
    Object.assign(set, {
      phoneRaw: fill.phone.phoneRaw,
      phoneE164: fill.phone.phoneE164,
      phoneCountryIso: fill.phone.phoneCountryIso,
      phoneStatus: fill.phone.phoneStatus,
    });
  if (fill.email) set.email = fill.email;
  if (fill.instagram) set.instagramHandle = fill.instagram;
  if (fill.value !== undefined) set.value = fill.value;
  if (fill.leadCreatedAt) set.leadCreatedAt = fill.leadCreatedAt;
  if (fill.ownerId) set.ownerId = fill.ownerId;
  if (fill.custom) set.custom = sql`${L.custom} || ${JSON.stringify(fill.custom)}::jsonb`;
  if (fill.reopenTo)
    Object.assign(set, {
      stageId: fill.reopenTo.stageId,
      wonAt: null,
      lostAt: null,
      lostReasonId: null,
      stageEnteredAt: new Date(),
    });
  await req.db.update(L).set(set).where(eq(L.id, lead.id));
  if (fill.tagIds?.length)
    await req.db
      .insert(schema.leadTags)
      .values(fill.tagIds.map((tagId) => ({ leadId: lead.id, tagId })))
      .onConflictDoNothing();
  if (fill.ownerId)
    await req.db.insert(schema.leadAssignmentHistory).values({
      leadId: lead.id,
      fromUserId: null,
      toUserId: fill.ownerId,
      changedBy: actorId,
      reason: "imported",
    });
  if (fill.reopenTo)
    await req.db.insert(schema.leadStageHistory).values({
      leadId: lead.id,
      fromStageId: lead.stageId,
      toStageId: fill.reopenTo.stageId,
      pipelineId: lead.pipelineId,
      changedBy: actorId,
    });
  await recordActivity(req, lead.id, activity.type, activity.payload);
}
