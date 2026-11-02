import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { PERMISSIONS, can, isPermissionKey, newId, permissionDef, type Scope } from "@lume/core";
import { schema, type LoginHours } from "@lume/db";
import { audit } from "../../audit/audit";
import { normaliseNetworks } from "../../auth/networks";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { assertCanAssignRoles, assertCanGrant } from "../../rbac/escalation";
import { notifyRbac } from "../../rbac/notify";
import type { AppDeps } from "../../app";
import { eraseAccount } from "../users/delete";
import { offboard, type LeadsChoice } from "../users/offboard";

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
  const fieldAccess = await req.db
    .select({ fieldId: schema.roleFieldAccess.fieldId, access: schema.roleFieldAccess.access })
    .from(schema.roleFieldAccess)
    .where(eq(schema.roleFieldAccess.roleId, id));
  const uses = await usesOf(req, id);
  return { ...role, grants: grants.sort((a, b) => a.key.localeCompare(b.key)), fieldAccess, holders, uses };
}

/**
 * Shared views keep their own row-level security (0027): someone who manages roles but not views can't see others'.
 * For these reads and the move below the request manages views, then goes back to what it was.
 */
async function asViewManager<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const before = (
    await req.db.execute(sql`SELECT coalesce(current_setting('lume.manage_views', true), '') AS v`)
  ).rows[0] as { v: string };
  await req.db.execute(sql`SELECT set_config('lume.manage_views', 'on', true)`);
  try {
    return await fn();
  } finally {
    await req.db.execute(sql`SELECT set_config('lume.manage_views', ${before.v}, true)`);
  }
}

/**
 * What else names the role (review 2026-10-25): invites not yet used (one can still be resent), templates limited to
 * it, views shared with it. Deleting it moves each of them to the replacement, like the people who hold it.
 */
async function usesOf(req: FastifyRequest, id: string) {
  const r = await asViewManager(req, () =>
    req.db.execute(sql`
      SELECT (SELECT count(*)::int FROM user_invites
               WHERE ${id}::uuid = ANY(role_ids) AND accepted_at IS NULL AND revoked_at IS NULL) AS invites,
             (SELECT count(*)::int FROM message_templates WHERE ${id}::uuid = ANY(allowed_role_ids)) AS templates,
             (SELECT count(*)::int FROM saved_views
               WHERE ${id}::uuid = ANY(shared_role_ids) AND deleted_at IS NULL) AS views`),
  );
  return r.rows[0] as { invites: number; templates: number; views: number };
}

/** Every list that names the old role names the replacement instead, once. */
async function moveUses(req: FastifyRequest, from: string, to: string) {
  await req.db.execute(sql`
    UPDATE user_invites SET role_ids = ARRAY(SELECT DISTINCT unnest(array_replace(role_ids, ${from}::uuid, ${to}::uuid)))
     WHERE ${from}::uuid = ANY(role_ids) AND accepted_at IS NULL AND revoked_at IS NULL`);
  await req.db.execute(sql`
    UPDATE message_templates
       SET allowed_role_ids = ARRAY(SELECT DISTINCT unnest(array_replace(allowed_role_ids, ${from}::uuid, ${to}::uuid)))
     WHERE ${from}::uuid = ANY(allowed_role_ids)`);
  await asViewManager(req, () =>
    req.db.execute(sql`
      UPDATE saved_views
         SET shared_role_ids = ARRAY(SELECT DISTINCT unnest(array_replace(shared_role_ids, ${from}::uuid, ${to}::uuid)))
       WHERE ${from}::uuid = ANY(shared_role_ids)`),
  );
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

/**
 * The roles this person may hand out when inviting or editing someone: those whose every grant they hold
 * themselves (the same rule assertCanAssignRoles enforces on write). Needs only users.manage, so an admin
 * who can invite but not edit roles still gets a role picker, and is never offered one that would fail.
 */
export async function listAssignableRoles(req: FastifyRequest) {
  const actor = req.actor!;
  const rows = await req.db
    .select({ id: schema.roles.id, name: schema.roles.name, color: schema.roles.color })
    .from(schema.roles)
    .where(isNull(schema.roles.deletedAt))
    .orderBy(schema.roles.name);
  const grants = await req.db
    .select({
      roleId: schema.rolePermissions.roleId,
      key: schema.rolePermissions.permissionKey,
      scope: schema.rolePermissions.scope,
    })
    .from(schema.rolePermissions);
  const holds = (g: { key: string; scope: Scope | null }) =>
    isPermissionKey(g.key) && can(actor, g.key, g.scope ?? undefined);
  return { roles: rows.filter((r) => grants.filter((g) => g.roleId === r.id).every(holds)) };
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
    ipAllowlist: await normaliseNetworks(req.db, input.ipAllowlist),
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
  if (fields.ipAllowlist !== undefined)
    fields.ipAllowlist = await normaliseNetworks(req.db, fields.ipAllowlist);
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

/** What happens to the people who hold a role being deleted (owner 2026-11-02). */
export type RolePeople =
  | { to: "role"; roleId: string }
  | { to: "new"; name: string }
  | { to: "offboard"; leads: LeadsChoice }
  | { to: "delete"; leads: LeadsChoice };

/**
 * Deleting a role (owner 2026-11-02; spec docs/superpowers/specs/2026-11-02-delete-account-and-role.md): the top of the
 * hierarchy, so the owner or someone who manages both roles and people, and always after the password (proved by the
 * route). Its people move to another role, to a new one made here as its copy, are offboarded, or have their accounts
 * deleted; the owner and the person deleting are only ever moved. Invites, templates and shared views that name it move
 * to the role its people went to, else to `replacementRoleId`.
 */
export async function deleteRole(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  o: { people?: RolePeople | undefined; replacementRoleId?: string | undefined },
) {
  const actor = req.actor!;
  if (!actor.isOwner && !(can(actor, "roles.manage") && can(actor, "users.manage")))
    throw forbidden(
      "TOP_OF_HIERARCHY",
      "Only the owner, or someone who manages roles and people, deletes a role",
    );
  const role = await getRole(req, id);
  const holders = (
    await req.db.execute(sql`
      SELECT u.id, u.is_owner FROM user_roles ur JOIN users u ON u.id = ur.user_id
       WHERE ur.role_id = ${id} AND u.status <> 'deleted'`)
  ).rows as { id: string; is_owner: boolean }[];
  const used = role.uses.invites + role.uses.templates + role.uses.views;
  const people = o.people;
  if (holders.length && !people)
    throw badRequest(
      "PEOPLE_CHOICE_REQUIRED",
      `${holders.length === 1 ? "1 person holds" : `${holders.length} people hold`} this role; choose what happens to them`,
    );

  // Where its people (and its invites, templates and views) go, when they go to a role.
  let moveTo: string | null = null;
  if (people?.to === "role") {
    if (people.roleId === id) throw badRequest("REPLACEMENT_REQUIRED", "Choose a different role");
    await getRole(req, people.roleId);
    moveTo = people.roleId;
  } else if (people?.to === "new") moveTo = (await cloneRole(req, id, people.name)).role.id;
  const forUses = moveTo ?? o.replacementRoleId ?? null;
  if (used && !forUses)
    throw badRequest(
      "REPLACEMENT_REQUIRED",
      "Invites, templates or shared views use this role; choose a replacement",
    );
  if (forUses && forUses === id) throw badRequest("REPLACEMENT_REQUIRED", "Choose a different role");

  if (holders.length && people) {
    if (people.to === "offboard" || people.to === "delete") {
      // Never the owner, never the person deleting: they're moved, from here only ever by choosing a role.
      if (holders.some((h) => h.is_owner || h.id === actor.userId))
        throw badRequest(
          "MOVE_THEM_INSTEAD",
          "You, or the owner, hold this role: move its people to another role instead",
        );
      const leads = people.leads;
      // The leads go to someone who stays: never one of the people leaving with this role.
      if (leads.to === "person" && holders.some((h) => h.id === leads.userId))
        throw badRequest("UNKNOWN_USER", "Pick someone outside this role to take the leads");
      for (const h of holders)
        if (people.to === "offboard") await offboard(req, d, h.id, people.leads);
        else await eraseAccount(req, d, h.id, people.leads);
    } else {
      await assertCanAssignRoles(req, [moveTo!]);
      // Move holders (skip anyone who already has the replacement), then drop the old links.
      await req.db.execute(
        sql`INSERT INTO user_roles (user_id, role_id) SELECT user_id, ${moveTo} FROM user_roles WHERE role_id = ${id} ON CONFLICT DO NOTHING`,
      );
    }
  }
  if (forUses) {
    await getRole(req, forUses);
    // Invites that move to a role may only move to one this person could hand out themselves (no way up through here).
    await assertCanAssignRoles(req, [forUses]);
    await moveUses(req, id, forUses);
  }
  await req.db.delete(schema.userRoles).where(eq(schema.userRoles.roleId, id));
  await req.db.update(schema.roles).set({ deletedAt: new Date() }).where(eq(schema.roles.id, id));
  await notifyRbac(req);
  await audit(req, {
    action: "role.deleted",
    entityType: "role",
    entityId: id,
    diff: {
      people: people?.to ?? null,
      movedTo: moveTo,
      replacementRoleId: forUses,
      holders: holders.length,
      uses: role.uses,
    },
  });
  return { movedTo: moveTo };
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
