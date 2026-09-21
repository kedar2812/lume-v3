import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { PERMISSIONS, isPermissionKey, newId, permissionDef, type Scope } from "@lume/core";
import { schema, type LoginHours } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { assertCanAssignRoles, assertCanGrant } from "../../rbac/escalation";
import { notifyRbac } from "../../rbac/notify";

export type GrantInput = { key: string; scope?: Scope | null };
export type RoleInput = {
  name: string;
  description?: string;
  color?: string;
  grants: GrantInput[];
  loginHours?: LoginHours | null;
  ipAllowlist?: string[] | null;
};

function normaliseGrants(grants: GrantInput[]) {
  const seen = new Map<string, Scope | null>();
  for (const g of grants) {
    if (!isPermissionKey(g.key)) throw badRequest("UNKNOWN_PERMISSION", `Unknown permission ${g.key}`);
    const def = permissionDef(g.key);
    if (!def.scoped && g.scope) throw badRequest("SCOPE_NOT_SUPPORTED", `${g.key} doesn't take a scope`);
    seen.set(g.key, def.scoped ? (g.scope ?? "own") : null);
  }
  return [...seen].map(([key, scope]) => ({ key, scope }));
}

async function getRole(req: FastifyRequest, id: string) {
  const [role] = await req.db
    .select()
    .from(schema.roles)
    .where(and(eq(schema.roles.id, id), isNull(schema.roles.deletedAt)));
  if (!role) throw notFound();
  const grants = await req.db
    .select({ key: schema.rolePermissions.permissionKey, scope: schema.rolePermissions.scope })
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, id));
  const [{ holders }] = (
    await req.db.execute(sql`SELECT count(*)::int AS holders FROM user_roles WHERE role_id = ${id}`)
  ).rows as [{ holders: number }];
  return { ...role, grants: grants.sort((a, b) => a.key.localeCompare(b.key)), holders };
}

async function writeGrants(req: FastifyRequest, roleId: string, grants: ReturnType<typeof normaliseGrants>) {
  await req.db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
  if (grants.length)
    await req.db
      .insert(schema.rolePermissions)
      .values(grants.map((g) => ({ roleId, permissionKey: g.key, scope: g.scope })));
}

async function assertNameFree(req: FastifyRequest, name: string, exceptId?: string) {
  const [dup] = await req.db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.name, name), isNull(schema.roles.deletedAt)));
  if (dup && dup.id !== exceptId) throw conflict("ROLE_EXISTS", "A role with that name already exists");
}

export const catalog = () => ({
  permissions: PERMISSIONS.map(({ key, group, label, description, scoped }) => ({
    key,
    group,
    label,
    description,
    scoped,
  })),
});

export async function listRoles(req: FastifyRequest) {
  const rows = await req.db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(isNull(schema.roles.deletedAt))
    .orderBy(schema.roles.name);
  // Sequential on purpose: one request = one transaction = one connection, which runs one query at a time.
  const roles = [];
  for (const r of rows) roles.push(await getRole(req, r.id));
  return { roles };
}

export const readRole = async (req: FastifyRequest, id: string) => ({ role: await getRole(req, id) });

export async function createRole(req: FastifyRequest, input: RoleInput) {
  const grants = normaliseGrants(input.grants);
  assertCanGrant(req, grants);
  await assertNameFree(req, input.name);
  const id = newId();
  await req.db.insert(schema.roles).values({
    id,
    name: input.name,
    description: input.description ?? "",
    color: input.color ?? "accent",
    loginHours: input.loginHours ?? null,
    ipAllowlist: input.ipAllowlist ?? null,
    createdBy: req.actor!.userId,
  });
  await writeGrants(req, id, grants);
  await audit(req, {
    action: "role.created",
    entityType: "role",
    entityId: id,
    diff: { name: input.name, grants },
  });
  return { role: await getRole(req, id) };
}

export async function updateRole(req: FastifyRequest, id: string, input: Partial<RoleInput>) {
  await getRole(req, id);
  if (input.name) await assertNameFree(req, input.name, id);
  const { grants: rawGrants, ...fields } = input;
  if (Object.keys(fields).length)
    await req.db.update(schema.roles).set(fields).where(eq(schema.roles.id, id));
  const grants = rawGrants ? normaliseGrants(rawGrants) : undefined;
  if (grants) assertCanGrant(req, grants);
  if (grants) await writeGrants(req, id, grants);
  await notifyRbac(req);
  await audit(req, {
    action: "role.updated",
    entityType: "role",
    entityId: id,
    diff: { ...fields, ...(grants ? { grants } : {}) },
  });
  return { role: await getRole(req, id) };
}

export async function deleteRole(req: FastifyRequest, id: string, replacementRoleId?: string) {
  const role = await getRole(req, id);
  if (role.holders > 0) {
    if (!replacementRoleId)
      throw badRequest("REPLACEMENT_REQUIRED", `${role.holders} people hold this role; choose a replacement`);
    if (replacementRoleId === id) throw badRequest("REPLACEMENT_REQUIRED", "Choose a different role");
    await getRole(req, replacementRoleId);
    await assertCanAssignRoles(req, [replacementRoleId]);
    // Move holders (skip anyone who already has the replacement), then drop the old links.
    await req.db.execute(
      sql`INSERT INTO user_roles (user_id, role_id) SELECT user_id, ${replacementRoleId} FROM user_roles WHERE role_id = ${id} ON CONFLICT DO NOTHING`,
    );
    await req.db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, id));
  }
  await req.db.update(schema.roles).set({ deletedAt: new Date() }).where(eq(schema.roles.id, id));
  await notifyRbac(req);
  await audit(req, {
    action: "role.deleted",
    entityType: "role",
    entityId: id,
    diff: { replacementRoleId: replacementRoleId ?? null, holders: role.holders },
  });
}

export async function cloneRole(req: FastifyRequest, id: string, name: string) {
  const src = await getRole(req, id);
  return createRole(req, {
    name,
    description: src.description,
    color: src.color,
    grants: src.grants,
    loginHours: src.loginHours,
    ipAllowlist: src.ipAllowlist,
  });
}
