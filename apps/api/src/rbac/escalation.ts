import { inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, isPermissionKey, type Scope } from "@lume/core";
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
}
