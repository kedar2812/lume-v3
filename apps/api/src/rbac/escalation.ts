import { inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { FIELD_ACCESS_RANK, can, isPermissionKey, type FieldAccess, type Scope } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError } from "../http/errors";

/**
 * Nobody can hand out access they don't hold themselves — not by writing it into a role
 * (roles.manage) and not by assigning a role that carries it (users.manage). Without this,
 * either permission alone would be a path to full control. The owner holds everything, so
 * the owner is never refused.
 */
export function assertCanGrant(req: FastifyRequest, grants: { key: string; scope: Scope | null }[]): void {
  const actor = req.actor!;
  const beyond = grants.filter((g) => !isPermissionKey(g.key) || !can(actor, g.key, g.scope ?? undefined));
  if (beyond.length) {
    throw new HttpError(403, "ESCALATION", "You can only give access you have yourself", {
      permissions: beyond.map((g) => g.key),
    });
  }
}

export async function assertCanAssignRoles(req: FastifyRequest, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return;
  const grants = await req.db
    .select({ key: schema.rolePermissions.permissionKey, scope: schema.rolePermissions.scope })
    .from(schema.rolePermissions)
    .where(inArray(schema.rolePermissions.roleId, roleIds));
  assertCanGrant(req, grants);
  await assertFieldsWithin(req, roleIds);
}

/**
 * A role handed out may not show a field wider than the person handing it out sees it: field access is the widest
 * any of someone's roles gives, so a role that shows a field hidden from you would show it to them (bug hunt
 * 2026-11-17). A field with no row in a role is `edit`.
 */
async function assertFieldsWithin(req: FastifyRequest, roleIds: string[]): Promise<void> {
  const beyond = new Set([...(await fieldsBeyond(req, roleIds)).values()].flatMap((s) => [...s]));
  if (beyond.size)
    throw new HttpError(403, "ESCALATION", "You can only give field access you have yourself", {
      fields: [...beyond],
    });
}

/** The roles of these that show no field wider than you see it: the ones you may hand out, as far as fields go. */
export async function rolesWithinFields(req: FastifyRequest, roleIds: string[]): Promise<Set<string>> {
  const beyond = await fieldsBeyond(req, roleIds);
  return new Set(roleIds.filter((id) => !beyond.has(id)));
}

/** Per role, the fields it shows wider than the actor sees them (none for the owner, or someone who sees all). */
async function fieldsBeyond(req: FastifyRequest, roleIds: string[]): Promise<Map<string, Set<string>>> {
  const actor = req.actor!;
  const out = new Map<string, Set<string>>();
  if (actor.isOwner || actor.fieldAccess.size === 0 || roleIds.length === 0) return out;
  const rows = await req.db
    .select({
      roleId: schema.roleFieldAccess.roleId,
      fieldId: schema.roleFieldAccess.fieldId,
      access: schema.roleFieldAccess.access,
    })
    .from(schema.roleFieldAccess)
    .where(inArray(schema.roleFieldAccess.roleId, roleIds));
  for (const [fieldId, mine] of actor.fieldAccess)
    for (const roleId of roleIds) {
      const theirs: FieldAccess =
        rows.find((r) => r.roleId === roleId && r.fieldId === fieldId)?.access ?? "edit";
      if (FIELD_ACCESS_RANK[theirs] > FIELD_ACCESS_RANK[mine]) {
        const s = out.get(roleId) ?? new Set<string>();
        s.add(fieldId);
        out.set(roleId, s);
      }
    }
  return out;
}
