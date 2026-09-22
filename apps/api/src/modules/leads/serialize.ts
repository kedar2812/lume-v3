import {
  canOnRecord,
  fieldAccessOf,
  formatPhone,
  maskEmail,
  maskInstagram,
  maskPhone,
  type PhoneStatus,
} from "@lume/core";
import type { schema } from "@lume/db";
import type { FieldRegistry } from "../../leads/fields";
import type { ActorRecord } from "../../rbac/actor";

export type LeadRow = typeof schema.leads.$inferSelect;
export type ContactView = { display: string; masked: boolean; status?: PhoneStatus };
export type LeadView = Record<string, unknown> & {
  id: string;
  version: number;
  pipelineId: string;
  contactMasked: boolean;
  tagIds: string[];
  custom: Record<string, unknown>;
};
export type SerializeCtx = { actor: ActorRecord; fields: FieldRegistry; tagIds: string[] };

/** Core field key → property it controls in the response (report §6 core fields). */
const CORE_PROPS: Record<string, string[]> = {
  name: ["name"],
  phone: ["phone"],
  email: ["email"],
  instagram: ["instagram"],
  owner: ["ownerId"],
  stage: ["stageId"],
  source: ["sourceId"],
  value: ["value", "currency"],
  lead_created_at: ["leadCreatedAt"],
};

export function isFieldVisible(ctx: Pick<SerializeCtx, "actor" | "fields">, key: string): boolean {
  const def = ctx.fields.byKey.get(key);
  return !def || fieldAccessOf(ctx.actor.fieldAccess, def.id) !== "hidden";
}

export function isFieldEditable(ctx: Pick<SerializeCtx, "actor" | "fields">, key: string): boolean {
  const def = ctx.fields.byKey.get(key);
  return !!def && !def.archived && fieldAccessOf(ctx.actor.fieldAccess, def.id) === "edit";
}

/**
 * The only way a lead leaves the API (report §7.4 layer 2). Contact values are masked unless the caller
 * has leads.contact.full on this lead; fields hidden from the caller are removed, not blanked.
 */
export function serializeLead(row: LeadRow, ctx: SerializeCtx): LeadView {
  const full = canOnRecord(ctx.actor, "leads.contact.full", row.ownerId);
  const phone: ContactView | null =
    row.phoneStatus === "missing"
      ? null
      : full
        ? {
            display: row.phoneE164 ? formatPhone(row.phoneE164) : (row.phoneRaw ?? ""),
            masked: false,
            status: row.phoneStatus,
          }
        : {
            display: maskPhone({ e164: row.phoneE164, raw: row.phoneRaw }),
            masked: true,
            status: row.phoneStatus,
          };
  const email: ContactView | null = row.email
    ? { display: full ? row.email.toLowerCase() : maskEmail(row.email.toLowerCase()), masked: !full }
    : null;
  const instagram: ContactView | null = row.instagramHandle
    ? { display: full ? `@${row.instagramHandle}` : maskInstagram(row.instagramHandle), masked: !full }
    : null;

  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.custom ?? {})) {
    const def = ctx.fields.byKey.get(key);
    if (def && !def.archived && !def.isCore && isFieldVisible(ctx, key)) custom[key] = value;
  }

  const view: LeadView = {
    id: row.id,
    version: row.version,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    ownerId: row.ownerId,
    name: row.name,
    phone,
    email,
    instagram,
    sourceId: row.sourceId,
    value: row.value,
    currency: row.currency,
    productId: row.productId,
    lostReasonId: row.lostReasonId,
    lostNote: row.lostNote,
    wonAt: row.wonAt,
    lostAt: row.lostAt,
    leadCreatedAt: row.leadCreatedAt,
    lastActivityAt: row.lastActivityAt,
    stageEnteredAt: row.stageEnteredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagIds: ctx.tagIds,
    custom,
    contactMasked: !full,
  };
  for (const [key, props] of Object.entries(CORE_PROPS)) {
    if (!isFieldVisible(ctx, key)) for (const p of props) delete view[p];
  }
  return view;
}
