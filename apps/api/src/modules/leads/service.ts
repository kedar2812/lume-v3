import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  canOnRecord,
  normalizeInstagram,
  normalizePhone,
  newId,
  scopeOf,
  type NormalizedPhone,
} from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry, type FieldRegistry } from "../../leads/fields";
import { findDuplicates } from "./duplicates";
import { isFieldEditable, serializeLead, type LeadRow } from "./serialize";

const L = schema.leads;

export type LeadInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  instagram?: string | null;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  value?: number | null;
  currency?: string | null;
  productId?: string | null;
  leadCreatedAt?: string | null;
  tagIds?: string[];
  custom?: Record<string, unknown>;
};

/** Core input property → the field key whose access governs writing it. */
const CORE_KEY: Record<string, string> = {
  name: "name",
  phone: "phone",
  email: "email",
  instagram: "instagram",
  ownerId: "owner",
  value: "value",
  currency: "value",
  leadCreatedAt: "lead_created_at",
};

export async function visibleLead(req: FastifyRequest, id: string): Promise<LeadRow> {
  const [row] = await req.db
    .select()
    .from(L)
    .where(and(eq(L.id, id), isNull(L.deletedAt)));
  if (!row) throw notFound("LEAD_NOT_FOUND", "Lead not found"); // out of scope looks exactly like missing
  return row;
}

export async function tagIdsOf(req: FastifyRequest, leadId: string): Promise<string[]> {
  return (
    await req.db
      .select({ id: schema.leadTags.tagId })
      .from(schema.leadTags)
      .where(eq(schema.leadTags.leadId, leadId))
  ).map((t) => t.id);
}

export async function leadViewFor(req: FastifyRequest, row: LeadRow, fields?: FieldRegistry) {
  return serializeLead(row, {
    actor: req.actor!,
    fields: fields ?? (await loadFieldRegistry(req)),
    tagIds: await tagIdsOf(req, row.id),
  });
}

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

function assertWritable(req: FastifyRequest, fields: FieldRegistry, input: LeadInput) {
  const ctx = { actor: req.actor!, fields };
  const blocked = new Set<string>();
  for (const [prop, key] of Object.entries(CORE_KEY))
    if (prop in input && !isFieldEditable(ctx, key)) blocked.add(key);
  for (const key of Object.keys(input.custom ?? {})) if (!isFieldEditable(ctx, key)) blocked.add(key);
  if (blocked.size)
    throw new HttpError(403, "FIELD_NOT_EDITABLE", "Some of these fields can't be changed by you", {
      fields: [...blocked],
    });
}

function validateCustom(
  fields: FieldRegistry,
  custom: Record<string, unknown> | undefined,
  mode: "create" | "patch",
) {
  const parsed = fields.custom[mode].safeParse(custom ?? {});
  if (!parsed.success)
    throw badRequest(
      "INVALID_CUSTOM_FIELDS",
      "Some fields are invalid",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  return parsed.data;
}

async function assertUsersExist(req: FastifyRequest, fields: FieldRegistry, custom: Record<string, unknown>) {
  const ids = Object.entries(custom)
    .filter(([k, v]) => fields.byKey.get(k)?.type === "user" && typeof v === "string")
    .map(([, v]) => v as string);
  if (!ids.length) return;
  const found = await req.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.id, ids), eq(schema.users.status, "active")));
  if (found.length !== new Set(ids).size)
    throw badRequest("UNKNOWN_USER", "One of those people doesn't exist or is disabled");
}

async function assertRefs(req: FastifyRequest, input: LeadInput) {
  if (input.productId) {
    const [p] = await req.db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.id, input.productId), isNull(schema.products.archivedAt)));
    if (!p) throw badRequest("UNKNOWN_PRODUCT", "That product doesn't exist");
  }
  if (input.tagIds?.length) {
    const found = await req.db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(inArray(schema.tags.id, input.tagIds));
    if (found.length !== new Set(input.tagIds).size)
      throw badRequest("UNKNOWN_TAG", "One of those tags doesn't exist");
  }
}

/** Who a new lead belongs to (report §7.4): yourself by default; someone else only within your assign scope. */
async function resolveOwner(
  req: FastifyRequest,
  requested: string | null | undefined,
): Promise<string | null> {
  const actor = req.actor!;
  if (requested === undefined || requested === actor.userId) return actor.userId;
  if (requested === null) {
    if (!actor.isOwner && scopeOf(actor, "leads.assign") !== "all")
      throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't leave leads unassigned");
    return null;
  }
  if (!canOnRecord(actor, "leads.assign", requested) || !canOnRecord(actor, "leads.view", requested)) {
    throw forbidden("ASSIGN_OUT_OF_SCOPE", "You can't create leads for that person");
  }
  const [u] = await req.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, requested), eq(schema.users.status, "active")));
  if (!u) throw badRequest("UNKNOWN_USER", "That person doesn't exist or is disabled");
  return requested;
}

async function resolveStage(
  req: FastifyRequest,
  pipelineId: string | undefined,
  stageId: string | undefined,
) {
  const [pipeline] = pipelineId
    ? await req.db
        .select()
        .from(schema.pipelines)
        .where(and(eq(schema.pipelines.id, pipelineId), isNull(schema.pipelines.archivedAt)))
    : await req.db
        .select()
        .from(schema.pipelines)
        .where(and(eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
  if (!pipeline) throw badRequest("UNKNOWN_PIPELINE", "That pipeline doesn't exist");
  const stages = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipeline.id), isNull(schema.stages.archivedAt)))
    .orderBy(schema.stages.position);
  const stage = stageId ? stages.find((s) => s.id === stageId) : stages.find((s) => s.kind === "open");
  if (!stage) throw badRequest("UNKNOWN_STAGE", "That stage isn't in this pipeline");
  if (stage.kind !== "open") throw badRequest("STAGE_NOT_OPEN", "New leads start in an open stage");
  return { pipelineId: pipeline.id, stageId: stage.id };
}

function contactColumns(input: LeadInput, defaultCountry: string | null) {
  const out: Partial<typeof L.$inferInsert> = {};
  let phone: NormalizedPhone | null = null;
  if ("phone" in input) {
    phone = normalizePhone(input.phone, defaultCountry);
    Object.assign(out, {
      phoneRaw: phone.raw,
      phoneE164: phone.e164,
      phoneCountryIso: phone.countryIso,
      phoneStatus: phone.status,
    });
  }
  if ("email" in input) out.email = input.email ? input.email.toLowerCase() : null;
  if ("instagram" in input)
    out.instagramHandle = input.instagram ? normalizeInstagram(input.instagram) : null;
  return { out, phone };
}

async function setTags(req: FastifyRequest, leadId: string, tagIds: string[]) {
  await req.db.delete(schema.leadTags).where(eq(schema.leadTags.leadId, leadId));
  if (tagIds.length)
    await req.db.insert(schema.leadTags).values([...new Set(tagIds)].map((tagId) => ({ leadId, tagId })));
}

export async function createLead(req: FastifyRequest, input: LeadInput & { name: string }) {
  const fields = await loadFieldRegistry(req);
  assertWritable(req, fields, input);
  const custom = validateCustom(fields, input.custom, "create");
  await assertUsersExist(req, fields, custom);
  await assertRefs(req, input);
  const ownerId = await resolveOwner(req, input.ownerId);
  const { pipelineId, stageId } = await resolveStage(req, input.pipelineId, input.stageId);
  const { out: contact } = contactColumns(input, fields.defaultCountry);
  const duplicates = await findDuplicates(req, {
    phoneE164: contact.phoneE164,
    email: contact.email,
    instagram: contact.instagramHandle,
  });

  const id = newId();
  const now = new Date();
  await req.db.insert(L).values({
    id,
    pipelineId,
    stageId,
    ownerId,
    name: input.name,
    ...contact,
    value: input.value ?? null,
    currency: input.currency ?? null,
    productId: input.productId ?? null,
    leadCreatedAt: input.leadCreatedAt ?? null,
    custom: Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null)),
    createdBy: req.actor!.userId,
    lastActivityAt: now,
    stageEnteredAt: now,
  });
  if (input.tagIds) await setTags(req, id, input.tagIds);
  await req.db
    .insert(schema.leadStageHistory)
    .values({ leadId: id, fromStageId: null, toStageId: stageId, pipelineId, changedBy: req.actor!.userId });
  if (ownerId)
    await req.db.insert(schema.leadAssignmentHistory).values({
      leadId: id,
      fromUserId: null,
      toUserId: ownerId,
      changedBy: req.actor!.userId,
      reason: "created",
    });
  await recordActivity(req, id, "lead_created", { source: "manual" });
  await audit(req, { action: "lead.create", entityType: "lead", entityId: id, diff: { ownerId, stageId } });
  return { lead: await leadViewFor(req, await visibleLead(req, id), fields), duplicates };
}

export async function getLead(req: FastifyRequest, id: string) {
  const row = await visibleLead(req, id);
  await audit(req, { action: "lead.view", entityType: "lead", entityId: id });
  return { lead: await leadViewFor(req, row) };
}

export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined)
    throw new HttpError(428, "PRECONDITION_REQUIRED", "Send If-Match with the version you edited");
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  if (!m) throw badRequest("BAD_IF_MATCH", "If-Match must be a lead version number");
  return Number(m[1]);
}

/**
 * The custom-fields update: merge what was set, then drop what was cleared. Drizzle spreads a JS array
 * into a parenthesised list, so the removed keys are built as an ARRAY[...] (and left out when empty:
 * `- ()::text[]` is a syntax error).
 */
function customMerge(merged: Record<string, unknown>, removed: string[]) {
  const withSet = sql`(${L.custom} || ${JSON.stringify(merged)}::jsonb)`;
  if (!removed.length) return withSet;
  return sql`${withSet} - ARRAY[${sql.join(
    removed.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
}

export async function updateLead(req: FastifyRequest, id: string, expectedVersion: number, input: LeadInput) {
  const fields = await loadFieldRegistry(req);
  const current = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "leads.edit", current.ownerId)) throw forbidden();
  if ("ownerId" in input || "stageId" in input || "pipelineId" in input) {
    throw badRequest("USE_DEDICATED_ENDPOINT", "Change the owner or stage with /assign or /stage");
  }
  assertWritable(req, fields, input);
  const custom = input.custom ? validateCustom(fields, input.custom, "patch") : {};
  await assertUsersExist(req, fields, custom);
  await assertRefs(req, input);
  const { out: contact } = contactColumns(input, fields.defaultCountry);

  const set: Record<string, unknown> = { ...contact };
  for (const k of ["name", "value", "currency", "productId", "leadCreatedAt"] as const)
    if (k in input) set[k] = input[k] ?? null;
  const removed = Object.entries(custom)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const merged = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null));
  const changed = [
    ...Object.keys(set),
    ...Object.keys(custom).map((k) => `custom.${k}`),
    ...(input.tagIds ? ["tags"] : []),
  ];

  const updated = await req.db
    .update(L)
    .set({
      ...set,
      ...(input.custom ? { custom: customMerge(merged, removed) } : {}),
      version: sql`${L.version} + 1`,
      lastActivityAt: new Date(),
    })
    .where(and(eq(L.id, id), eq(L.version, expectedVersion), isNull(L.deletedAt)))
    .returning({ id: L.id });
  if (updated.length === 0) {
    throw new HttpError(409, "VERSION_CONFLICT", "Someone else changed this lead. Reload and try again.", {
      currentVersion: current.version,
    });
  }
  if (input.tagIds) await setTags(req, id, input.tagIds);
  // Field names only, never values: contact changes must not leak into history.
  const fieldKeys = changed
    .map((c) => c.replace(/^custom\./, ""))
    .map(
      (k) =>
        ({
          phoneRaw: "phone",
          phoneE164: "phone",
          phoneCountryIso: "phone",
          phoneStatus: "phone",
          instagramHandle: "instagram",
        })[k] ?? k,
    );
  const fieldList = [...new Set(fieldKeys)];
  await recordActivity(req, id, "field_changed", { fields: fieldList });
  await audit(req, { action: "lead.update", entityType: "lead", entityId: id, diff: { fields: fieldList } });
  return { lead: await leadViewFor(req, await visibleLead(req, id), fields) };
}

export async function deleteLead(req: FastifyRequest, id: string) {
  const current = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "leads.delete", current.ownerId)) throw forbidden();
  await req.db
    .update(L)
    .set({ deletedAt: new Date(), version: sql`${L.version} + 1` })
    .where(eq(L.id, id));
  await audit(req, { action: "lead.delete", entityType: "lead", entityId: id });
}
