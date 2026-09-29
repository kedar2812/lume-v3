import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId, type TemplateCategory } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";

const M = schema.messageTemplates;
const V = schema.templateVersions;

export type TemplateView = {
  id: string;
  name: string;
  category: TemplateCategory;
  allowedRoleIds: string[];
  versionId: string;
  /** Which edit this is: 1 for the first words, 2 after the first change… */
  version: number;
  body: string;
  position: number;
  updatedAt: string;
  /** Whether the caller's roles may send it (a manager sees every template, usable or not). */
  usable: boolean;
};
export type TemplateInput = {
  name?: string;
  category?: TemplateCategory;
  body?: string;
  allowedRoleIds?: string[];
};

const managing = (req: FastifyRequest) => can(req.actor!, "templates.manage");
/** Empty means everyone who may use templates; otherwise one of the caller's roles. */
const usableBy = (req: FastifyRequest, allowed: string[]) =>
  allowed.length === 0 || req.actor!.isOwner || allowed.some((r) => req.actor!.roleIds.includes(r));

async function rows(req: FastifyRequest, id?: string) {
  return req.db
    .select({
      id: M.id,
      name: M.name,
      category: M.category,
      allowedRoleIds: M.allowedRoleIds,
      versionId: M.currentVersionId,
      body: V.body,
      version: sql<number>`(SELECT count(*)::int FROM template_versions tv WHERE tv.template_id = ${M.id})`,
      position: M.position,
      updatedAt: M.updatedAt,
    })
    .from(M)
    .innerJoin(V, eq(V.id, M.currentVersionId))
    .where(id ? and(eq(M.id, id), isNull(M.archivedAt)) : isNull(M.archivedAt))
    .orderBy(asc(M.position), asc(M.createdAt));
}
const view = (req: FastifyRequest, r: Awaited<ReturnType<typeof rows>>[number]): TemplateView => ({
  ...r,
  versionId: r.versionId!,
  updatedAt: r.updatedAt.toISOString(),
  usable: usableBy(req, r.allowedRoleIds),
});

/** The templates the caller may use; a manager sees them all (Phase 4 spec §3 "Role availability"). */
export async function listTemplates(
  req: FastifyRequest,
): Promise<{ templates: TemplateView[]; roles?: { id: string; name: string }[] }> {
  const all = (await rows(req)).map((r) => view(req, r));
  if (!managing(req)) return { templates: all.filter((t) => t.usable) };
  // A manager chooses who can use each template: the roles, by name.
  const roles = await req.db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(isNull(schema.roles.deletedAt))
    .orderBy(asc(schema.roles.name));
  return { templates: all, roles };
}

export async function oneTemplate(req: FastifyRequest, id: string): Promise<TemplateView> {
  const [r] = await rows(req, id);
  if (!r) throw notFound("TEMPLATE_NOT_FOUND", "That template no longer exists");
  return view(req, r);
}

async function assertRoles(req: FastifyRequest, ids: string[] | undefined) {
  if (!ids?.length) return;
  const found = await req.db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(inArray(schema.roles.id, [...new Set(ids)]), isNull(schema.roles.deletedAt)));
  if (found.length !== new Set(ids).size)
    throw badRequest("UNKNOWN_ROLE", "One of those roles doesn't exist");
}
async function assertNameFree(req: FastifyRequest, name: string, except?: string) {
  const [taken] = await req.db
    .select({ id: M.id })
    .from(M)
    .where(
      and(sql`${M.name} = ${name}::citext`, isNull(M.archivedAt), ...(except ? [ne(M.id, except)] : [])),
    );
  if (taken) throw conflict("TEMPLATE_EXISTS", "A template with that name already exists");
}

export async function createTemplate(
  req: FastifyRequest,
  input: Required<Omit<TemplateInput, "allowedRoleIds">> & { allowedRoleIds?: string[] },
): Promise<TemplateView> {
  await assertNameFree(req, input.name);
  await assertRoles(req, input.allowedRoleIds);
  const id = newId();
  const versionId = newId();
  const [{ n }] = (
    await req.db.execute<{ n: number }>(
      sql`SELECT coalesce(max(position) + 1, 0)::int AS n FROM message_templates WHERE archived_at IS NULL`,
    )
  ).rows as [{ n: number }];
  await req.db.insert(M).values({
    id,
    name: input.name,
    category: input.category,
    allowedRoleIds: input.allowedRoleIds ?? [],
    position: n,
    createdBy: req.actor!.userId,
  });
  await req.db
    .insert(V)
    .values({ id: versionId, templateId: id, body: input.body, createdBy: req.actor!.userId });
  await req.db.update(M).set({ currentVersionId: versionId }).where(eq(M.id, id));
  await audit(req, {
    action: "template.created",
    entityType: "template",
    entityId: id,
    diff: { name: input.name, category: input.category },
  });
  return oneTemplate(req, id);
}

/** A change to the words is a new version (history never changes); the rest changes in place. */
export async function updateTemplate(
  req: FastifyRequest,
  id: string,
  patch: TemplateInput,
): Promise<TemplateView> {
  const before = await oneTemplate(req, id);
  if (patch.name !== undefined && patch.name !== before.name) await assertNameFree(req, patch.name, id);
  await assertRoles(req, patch.allowedRoleIds);
  let versionId = before.versionId;
  const newVersion = patch.body !== undefined && patch.body !== before.body;
  if (newVersion) {
    versionId = newId();
    await req.db
      .insert(V)
      .values({ id: versionId, templateId: id, body: patch.body!, createdBy: req.actor!.userId });
  }
  await req.db
    .update(M)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.allowedRoleIds !== undefined ? { allowedRoleIds: patch.allowedRoleIds } : {}),
      currentVersionId: versionId,
      updatedAt: new Date(),
    })
    .where(eq(M.id, id));
  await audit(req, {
    action: "template.updated",
    entityType: "template",
    entityId: id,
    diff: { name: patch.name ?? before.name, ...(newVersion ? { newVersion: true } : {}) },
  });
  return oneTemplate(req, id);
}

export async function archiveTemplate(req: FastifyRequest, id: string): Promise<{ archived: true }> {
  const t = await oneTemplate(req, id);
  await req.db.update(M).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(M.id, id));
  await audit(req, {
    action: "template.archived",
    entityType: "template",
    entityId: id,
    diff: { name: t.name },
  });
  return { archived: true };
}

/** Archive, undone: the template comes back, if its name is still free. */
export async function restoreTemplate(req: FastifyRequest, id: string): Promise<TemplateView> {
  const [t] = await req.db.select({ name: M.name }).from(M).where(eq(M.id, id));
  if (!t) throw notFound("TEMPLATE_NOT_FOUND", "That template no longer exists");
  await assertNameFree(req, t.name, id);
  await req.db.update(M).set({ archivedAt: null, updatedAt: new Date() }).where(eq(M.id, id));
  await audit(req, {
    action: "template.restored",
    entityType: "template",
    entityId: id,
    diff: { name: t.name },
  });
  return oneTemplate(req, id);
}

export async function reorderTemplates(
  req: FastifyRequest,
  ids: string[],
): Promise<{ templates: TemplateView[] }> {
  const live = await rows(req);
  if (new Set(ids).size !== ids.length || live.length !== ids.length || live.some((t) => !ids.includes(t.id)))
    throw badRequest("TEMPLATE_ORDER_INCOMPLETE", "List every template exactly once");
  for (const [i, id] of ids.entries()) await req.db.update(M).set({ position: i }).where(eq(M.id, id));
  await audit(req, { action: "template.reordered", entityType: "template", diff: { ids } });
  return listTemplates(req);
}
