import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { revokeUserSessions } from "../../auth/sessions";
import { badRequest, forbidden, notFound } from "../../http/errors";
import { assertCanAssignRoles } from "../../rbac/escalation";
import { notifyRbac } from "../../rbac/notify";

async function target(req: FastifyRequest, id: string) {
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, id)).for("update");
  if (!u) throw notFound();
  return u;
}
const ownerGuard = (u: { isOwner: boolean }) => {
  if (u.isOwner) throw forbidden("OWNER_PROTECTED", "The owner account can't be changed by anyone else");
};

export async function listUsers(req: FastifyRequest) {
  const users = await req.db.select().from(schema.users).orderBy(schema.users.name);
  const links = await req.db
    .select({ userId: schema.userRoles.userId, id: schema.roles.id, name: schema.roles.name })
    .from(schema.userRoles)
    .innerJoin(
      schema.roles,
      and(eq(schema.roles.id, schema.userRoles.roleId), isNull(schema.roles.deletedAt)),
    );
  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      isOwner: u.isOwner,
      twoFactor: u.totpEnabled,
      lastLoginAt: u.lastLoginAt,
      roles: links.filter((l) => l.userId === u.id).map(({ id, name }) => ({ id, name })),
    })),
  };
}

export async function updateUser(
  req: FastifyRequest,
  id: string,
  patch: { name?: string; roleIds?: string[] },
) {
  const u = await target(req, id);
  if (patch.roleIds) {
    ownerGuard(u);
    const found = patch.roleIds.length
      ? await req.db
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(and(inArray(schema.roles.id, patch.roleIds), isNull(schema.roles.deletedAt)))
      : [];
    if (found.length !== new Set(patch.roleIds).size)
      throw badRequest("UNKNOWN_ROLE", "One of those roles doesn't exist");
    await assertCanAssignRoles(req, patch.roleIds);
    await req.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, id));
    if (patch.roleIds.length)
      await req.db
        .insert(schema.userRoles)
        .values([...new Set(patch.roleIds)].map((roleId) => ({ userId: id, roleId })));
    await notifyRbac(req, id);
  }
  if (patch.name) await req.db.update(schema.users).set({ name: patch.name }).where(eq(schema.users.id, id));
  await audit(req, {
    action: "user.updated",
    entityType: "user",
    entityId: id,
    diff: {
      ...(patch.roleIds ? { roleIds: patch.roleIds } : {}),
      ...(patch.name ? { name: patch.name } : {}),
    },
  });
}

/**
 * Disable or enable someone. Disabling can hand every lead they own to a colleague (`reassignTo`), or
 * leave them unassigned (`null`); leaving it out keeps them where they are.
 */
export async function setDisabled(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  disabled: boolean,
  reassignTo?: string | null,
) {
  const u = await target(req, id);
  ownerGuard(u);
  if (id === req.actor!.userId) throw forbidden("SELF", "You can't disable yourself");
  if (disabled && reassignTo) {
    const [to] = await req.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, reassignTo), eq(schema.users.status, "active")));
    if (!to || reassignTo === id) throw badRequest("UNKNOWN_USER", "Pick someone active to take the leads");
  }
  const now = d.clock();
  await req.db
    .update(schema.users)
    .set({ status: disabled ? "disabled" : "active", disabledAt: disabled ? now : null })
    .where(eq(schema.users.id, id));
  if (disabled) await revokeUserSessions(req.db, id, "user_disabled", now);
  let leads: number | undefined;
  if (disabled && reassignTo !== undefined) {
    const r = await req.db.execute<{ n: number }>(
      sql`SELECT reassign_all_leads(${id}, ${reassignTo}, ${req.actor!.userId}) AS n`,
    );
    leads = Number(r.rows[0]?.n ?? 0);
  }
  await notifyRbac(req, id);
  await audit(req, {
    action: disabled ? "user.disabled" : "user.enabled",
    entityType: "user",
    entityId: id,
    ...(leads !== undefined ? { diff: { reassignedTo: reassignTo, leads } } : {}),
  });
}

export async function killSessions(req: FastifyRequest, d: AppDeps, id: string) {
  const u = await target(req, id);
  if (u.isOwner && id !== req.actor!.userId) ownerGuard(u);
  const n = await revokeUserSessions(req.db, id, "revoked_by_admin", d.clock());
  await audit(req, { action: "session.revoked_all", entityType: "user", entityId: id, diff: { count: n } });
}
