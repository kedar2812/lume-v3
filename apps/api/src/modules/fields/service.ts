import { and, eq, max } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { CORE_FIELD_KEYS, can, fieldAccessOf, newId, type FieldType } from "@lume/core";
import { schema, type FieldOptionRow } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { bumpFieldDefs } from "../../leads/fields";

const OPTION_TYPES: FieldType[] = ["select", "multi_select"];
type FieldRow = typeof schema.fieldDefinitions.$inferSelect;
export type OptionInput = { id?: string; label: string; color?: string };

const view = (f: FieldRow, access: string) => ({
  id: f.id,
  key: f.key,
  label: f.label,
  type: f.type,
  options: f.options,
  isCore: f.isCore,
  isRequired: f.isRequired,
  isSearchable: f.isSearchable,
  position: f.position,
  archived: f.archivedAt !== null,
  access,
});

async function field(req: FastifyRequest, id: string) {
  const [f] = await req.db.select().from(schema.fieldDefinitions).where(eq(schema.fieldDefinitions.id, id));
  if (!f) throw notFound("FIELD_NOT_FOUND", "Field not found");
  return f;
}

/** Existing options keep their ids; options left out of the list are archived, never deleted (data refers to them). */
function mergeOptions(existing: FieldOptionRow[], incoming: OptionInput[]): FieldOptionRow[] {
  const byId = new Map(existing.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const out: FieldOptionRow[] = [];
  for (const o of incoming) {
    if (o.id && !byId.has(o.id)) throw badRequest("UNKNOWN_OPTION", "One of those options doesn't exist");
    const id = o.id ?? newId();
    seen.add(id);
    out.push({ id, label: o.label, ...(o.color ? { color: o.color } : {}) });
  }
  for (const o of existing) if (!seen.has(o.id)) out.push({ ...o, archived: true });
  const live = out.filter((o) => !o.archived).map((o) => o.label.toLowerCase());
  if (new Set(live).size !== live.length)
    throw badRequest("DUPLICATE_OPTION", "Two options have the same name");
  return out;
}

export async function listFields(req: FastifyRequest) {
  const actor = req.actor!;
  const manager = can(actor, "fields.manage");
  const rows = await req.db.select().from(schema.fieldDefinitions).orderBy(schema.fieldDefinitions.position);
  return {
    fields: rows
      .map((f) => view(f, fieldAccessOf(actor.fieldAccess, f.id)))
      .filter((f) => manager || (f.access !== "hidden" && !f.archived)),
  };
}

export async function createField(
  req: FastifyRequest,
  input: {
    key: string;
    label: string;
    type: FieldType;
    options?: OptionInput[];
    isRequired?: boolean;
    isSearchable?: boolean;
  },
) {
  if (CORE_FIELD_KEYS.has(input.key)) throw conflict("FIELD_EXISTS", "That key belongs to a built-in field");
  const [dup] = await req.db
    .select({ id: schema.fieldDefinitions.id })
    .from(schema.fieldDefinitions)
    .where(eq(schema.fieldDefinitions.key, input.key));
  if (dup) throw conflict("FIELD_EXISTS", "A field with that key already exists");
  if (!OPTION_TYPES.includes(input.type) && input.options?.length)
    throw badRequest("OPTIONS_NOT_ALLOWED", "Only select fields have options");
  const [{ top } = { top: null }] = await req.db
    .select({ top: max(schema.fieldDefinitions.position) })
    .from(schema.fieldDefinitions);
  const id = newId();
  await req.db.insert(schema.fieldDefinitions).values({
    id,
    key: input.key,
    label: input.label,
    type: input.type,
    options: mergeOptions([], input.options ?? []),
    isRequired: input.isRequired ?? false,
    isSearchable: input.isSearchable ?? false,
    position: (top ?? -1) + 1,
  });
  await bumpFieldDefs(req);
  await audit(req, {
    action: "field.created",
    entityType: "field",
    entityId: id,
    diff: { key: input.key, type: input.type },
  });
  return { field: view(await field(req, id), "edit") };
}

export async function updateField(
  req: FastifyRequest,
  id: string,
  patch: {
    label?: string;
    options?: OptionInput[];
    isRequired?: boolean;
    isSearchable?: boolean;
    position?: number;
    type?: string;
  },
) {
  const f = await field(req, id);
  if (patch.type !== undefined && patch.type !== f.type)
    throw badRequest("TYPE_IMMUTABLE", "A field's type can't be changed yet");
  if (f.archivedAt) throw badRequest("FIELD_ARCHIVED", "Archived fields can't be edited");
  if (f.isCore && (patch.options || patch.isRequired !== undefined || patch.isSearchable !== undefined)) {
    throw badRequest("CORE_FIELD", "Built-in fields can only be renamed or moved");
  }
  if (patch.options && !OPTION_TYPES.includes(f.type))
    throw badRequest("OPTIONS_NOT_ALLOWED", "Only select fields have options");
  const set: Partial<typeof schema.fieldDefinitions.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.isRequired !== undefined) set.isRequired = patch.isRequired;
  if (patch.isSearchable !== undefined) set.isSearchable = patch.isSearchable;
  if (patch.options) set.options = mergeOptions(f.options, patch.options);
  if (Object.keys(set).length) {
    await req.db.update(schema.fieldDefinitions).set(set).where(eq(schema.fieldDefinitions.id, id));
    await bumpFieldDefs(req);
  }
  await audit(req, {
    action: "field.updated",
    entityType: "field",
    entityId: id,
    diff: { fields: Object.keys(set) },
  });
  return { field: view(await field(req, id), fieldAccessOf(req.actor!.fieldAccess, id)) };
}

export async function archiveField(req: FastifyRequest, id: string) {
  const f = await field(req, id);
  if (f.isCore) throw badRequest("CORE_FIELD", "Built-in fields can be hidden per role, not archived");
  if (f.archivedAt) return;
  await req.db
    .update(schema.fieldDefinitions)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.fieldDefinitions.id, id)));
  await bumpFieldDefs(req);
  await audit(req, { action: "field.archived", entityType: "field", entityId: id, diff: { key: f.key } });
}
