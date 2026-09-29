import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { leadFilters, type FilterQuery } from "../leads/query";
import { filterQuerySchema } from "../leads/routes";

const V = schema.savedViews;
/** The filters a view stores: the Leads list's own API query, as strings (what the address bar holds). */
export type ViewFilters = Record<string, string>;
export type ViewView = {
  id: string;
  name: string;
  color: string;
  filters: ViewFilters;
  sharedRoleIds: string[];
  shared: boolean;
  mine: boolean;
  canEdit: boolean;
};
export type ViewInput = { name: string; color: string; filters: ViewFilters; sharedRoleIds?: string[] };
type Row = typeof V.$inferSelect;

const manages = (req: FastifyRequest) => can(req.actor!, "views.manage");
function toView(req: FastifyRequest, r: Row): ViewView {
  const mine = r.ownerId === req.actor!.userId;
  const shared = r.sharedRoleIds.length > 0;
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    filters: r.filters as ViewFilters,
    sharedRoleIds: r.sharedRoleIds,
    shared,
    mine,
    canEdit: mine || (shared && manages(req)),
  };
}

/** Only the filters LUME knows, each checked as the list checks it; kept as the strings they came as. */
function cleanFilters(filters: ViewFilters): ViewFilters {
  const known = Object.keys(filterQuerySchema.shape);
  const kept = Object.fromEntries(Object.entries(filters).filter(([k]) => known.includes(k)));
  if (!filterQuerySchema.safeParse(kept).success)
    throw badRequest("BAD_FILTER", "Those filters aren't ones LUME can save");
  return kept;
}
function assertShare(req: FastifyRequest, roleIds: string[] | undefined) {
  if (roleIds?.length && !manages(req))
    throw forbidden("CANT_SHARE", "Sharing views is for people who manage them");
}
async function visible(req: FastifyRequest): Promise<Row[]> {
  // Row-level security decides which views these are: the caller's own, and those shared with them.
  return req.db.select().from(V).where(isNull(V.deletedAt)).orderBy(desc(V.createdAt));
}
async function one(req: FastifyRequest, id: string, withDeleted = false): Promise<Row> {
  const [r] = await req.db
    .select()
    .from(V)
    .where(withDeleted ? eq(V.id, id) : and(eq(V.id, id), isNull(V.deletedAt)));
  if (!r) throw notFound("VIEW_NOT_FOUND", "That view no longer exists");
  return r;
}
async function assertNameFree(req: FastifyRequest, name: string, except?: string) {
  const taken = (await visible(req)).some(
    (v) => v.id !== except && v.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw conflict("VIEW_EXISTS", "You already have a view with that name");
}
function assertEditable(req: FastifyRequest, r: Row) {
  if (!toView(req, r).canEdit) throw forbidden("VIEW_NOT_YOURS", "That view isn't yours to change");
}

/** The caller's views in their own order (4B ruling R2); any not placed yet come after, oldest first. */
export async function listViews(
  req: FastifyRequest,
): Promise<{ views: ViewView[]; roles?: { id: string; name: string }[] }> {
  const rows = await visible(req);
  const [u] = await req.db
    .select({ order: schema.users.viewOrder })
    .from(schema.users)
    .where(eq(schema.users.id, req.actor!.userId));
  const order = u?.order ?? [];
  const at = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...rows].sort(
    (a, b) => at(a.id) - at(b.id) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  // Whoever may share also gets the roles to share with (as templates do).
  const roles = manages(req)
    ? await req.db
        .select({ id: schema.roles.id, name: schema.roles.name })
        .from(schema.roles)
        .orderBy(schema.roles.name)
    : undefined;
  return { views: sorted.map((r) => toView(req, r)), ...(roles ? { roles } : {}) };
}

export async function createView(req: FastifyRequest, input: ViewInput): Promise<ViewView> {
  assertShare(req, input.sharedRoleIds);
  await assertNameFree(req, input.name);
  const id = newId();
  await req.db.insert(V).values({
    id,
    name: input.name,
    color: input.color,
    filters: cleanFilters(input.filters),
    ownerId: req.actor!.userId,
    sharedRoleIds: input.sharedRoleIds ?? [],
  });
  await audit(req, { action: "view.created", entityType: "view", entityId: id, diff: { name: input.name } });
  return toView(req, await one(req, id));
}

export async function updateView(req: FastifyRequest, id: string, patch: Partial<ViewInput>) {
  const r = await one(req, id);
  assertEditable(req, r);
  // Sharing or un-sharing is a manager's call either way.
  if (patch.sharedRoleIds !== undefined && !manages(req))
    throw forbidden("CANT_SHARE", "Sharing views is for people who manage them");
  if (patch.name) await assertNameFree(req, patch.name, id);
  await req.db
    .update(V)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.color ? { color: patch.color } : {}),
      ...(patch.filters ? { filters: cleanFilters(patch.filters) } : {}),
      ...(patch.sharedRoleIds ? { sharedRoleIds: patch.sharedRoleIds } : {}),
      updatedAt: new Date(),
    })
    .where(eq(V.id, id));
  await audit(req, {
    action: "view.updated",
    entityType: "view",
    entityId: id,
    diff: { name: patch.name ?? r.name },
  });
  return toView(req, await one(req, id));
}

export async function deleteView(req: FastifyRequest, id: string): Promise<void> {
  const r = await one(req, id);
  assertEditable(req, r);
  await req.db.update(V).set({ deletedAt: new Date() }).where(eq(V.id, id));
  await audit(req, { action: "view.deleted", entityType: "view", entityId: id, diff: { name: r.name } });
}

/** Undo: back as it was, if its name is still free. */
export async function restoreView(req: FastifyRequest, id: string): Promise<ViewView> {
  const r = await one(req, id, true);
  assertEditable(req, r);
  await assertNameFree(req, r.name, id);
  await req.db.update(V).set({ deletedAt: null }).where(eq(V.id, id));
  await audit(req, { action: "view.restored", entityType: "view", entityId: id, diff: { name: r.name } });
  return toView(req, await one(req, id));
}

/** A person's own order of the views they see; nobody else's sidebar moves. */
export async function orderViews(req: FastifyRequest, ids: string[]) {
  const seen = new Set((await visible(req)).map((v) => v.id));
  await req.db
    .update(schema.users)
    .set({ viewOrder: ids.filter((id) => seen.has(id)) })
    .where(eq(schema.users.id, req.actor!.userId));
  return listViews(req);
}

/**
 * Every view's count in one query, under the caller's own row-level security (spec §3 View counts). A view
 * whose filters no longer hold (a field archived, a stage, tag or reason gone) counts null ("—"), and the
 * rest still count (Review Focus 2).
 */
export async function viewCounts(req: FastifyRequest): Promise<{ counts: Record<string, number | null> }> {
  const rows = await visible(req);
  const fields = await loadFieldRegistry(req);
  const counts: Record<string, number | null> = {};
  const parts: { id: string; where: SQL }[] = [];
  for (const r of rows) {
    const parsed = filterQuerySchema.safeParse(r.filters);
    if (!parsed.success || (await stale(req, parsed.data))) {
      counts[r.id] = null;
      continue;
    }
    try {
      parts.push({ id: r.id, where: and(...leadFilters(req, parsed.data, fields))! });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      counts[r.id] = null;
    }
  }
  if (parts.length) {
    const cols = sql.join(
      parts.map((p, i) => sql`count(*) FILTER (WHERE ${p.where})::int AS ${sql.identifier(`c${i}`)}`),
      sql`, `,
    );
    const [out] = (await req.db.execute(sql`SELECT ${cols} FROM leads`)).rows as Record<string, number>[];
    parts.forEach((p, i) => (counts[p.id] = out?.[`c${i}`] ?? 0));
  }
  return { counts };
}

/** Filters that name something no longer there: the view can't be counted as it was meant. */
async function stale(req: FastifyRequest, q: FilterQuery): Promise<boolean> {
  const live = async (table: string, id: string, extra = "") =>
    (
      await req.db.execute(
        sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id} ${sql.raw(extra)} LIMIT 1`,
      )
    ).rows.length > 0;
  for (const id of q.stageId?.split(",") ?? [])
    if (!(await live("stages", id, "AND archived_at IS NULL"))) return true;
  if (q.tagId && !(await live("tags", q.tagId))) return true;
  if (q.lostReasonId && !(await live("lost_reasons", q.lostReasonId, "AND archived_at IS NULL"))) return true;
  return false;
}
