import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { FIELD_ACCESS_RANK, fieldAccessOf, type FieldAccess } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

/** Replace a role's field-access rows. `edit` is the default, so only hidden/view rows are stored. */
export async function setFieldAccess(
  req: FastifyRequest,
  roleId: string,
  entries: { fieldId: string; access: FieldAccess }[],
) {
  const [role] = await req.db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.id, roleId), isNull(schema.roles.deletedAt)));
  if (!role) throw notFound("ROLE_NOT_FOUND", "Role not found");
  const ids = entries.map((e) => e.fieldId);
  if (new Set(ids).size !== ids.length) throw badRequest("DUPLICATE_FIELD", "A field is listed twice");
  if (ids.length) {
    const found = await req.db
      .select({ id: schema.fieldDefinitions.id })
      .from(schema.fieldDefinitions)
      .where(inArray(schema.fieldDefinitions.id, ids));
    if (found.length !== ids.length) throw badRequest("UNKNOWN_FIELD", "One of those fields doesn't exist");
  }
  // Escalation guard (as in 1A): the resulting access for every field may not exceed the actor's own.
  const actor = req.actor!;
  if (!actor.isOwner) {
    const allFields = await req.db.select({ id: schema.fieldDefinitions.id }).from(schema.fieldDefinitions);
    const given = new Map(entries.map((e) => [e.fieldId, e.access]));
    const beyond = allFields
      .map((f) => ({ id: f.id, access: given.get(f.id) ?? ("edit" as FieldAccess) }))
      .filter((f) => FIELD_ACCESS_RANK[f.access] > FIELD_ACCESS_RANK[fieldAccessOf(actor.fieldAccess, f.id)]);
    if (beyond.length) {
      throw new HttpError(403, "ESCALATION", "You can only give field access you have yourself", {
        fields: beyond.map((f) => f.id),
      });
    }
  }
  await req.db.delete(schema.roleFieldAccess).where(eq(schema.roleFieldAccess.roleId, roleId));
  const stored = entries.filter((e) => e.access !== "edit");
  if (stored.length)
    await req.db.insert(schema.roleFieldAccess).values(stored.map((e) => ({ roleId, ...e })));
  await notifyRbac(req);
  await audit(req, {
    action: "role.field_access.updated",
    entityType: "role",
    entityId: roleId,
    diff: { entries: stored },
  });
  return { entries: stored };
}
