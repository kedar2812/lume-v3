import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { countable, countLeads, leadFilters, resolveSearch, type FilterQuery } from "../leads/query";
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
/** A view the caller sees (their own, or shared with them), for a send queue to plan from (4C). */
export const viewById = (req: FastifyRequest, id: string) => one(req, id);
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
  // Private means its owner's alone: only they can take it back (4B review, Important 1).
  if (patch.sharedRoleIds?.length === 0 && r.sharedRoleIds.length > 0 && r.ownerId !== req.actor!.userId)
    throw forbidden("CANT_UNSHARE", "Only its owner can make a shared view private");
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
export async function viewCounts(
  req: FastifyRequest,
): Promise<{ counts: Record<string, number | null>; capped: string[] }> {
  const rows = await visible(req);
  const fields = await loadFieldRegistry(req);
  const counts: Record<string, number | null> = {};
  // Views whose search matched past the cap (7A): their count is of the newest matches, and they say so.
  const capped: string[] = [];
  const parts: { id: string; where: SQL; counted?: FilterQuery & { pipelineId: string } }[] = [];
  // A view naming no pipeline opens on the default one (the list shows one pipeline at a time), so it
  // counts that one too (4B review, Important 2).
  const [byDefault] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(eq(schema.pipelines.isDefault, true));
  const parsed = rows.map((r) => ({ r, p: filterQuerySchema.safeParse(r.filters) }));
  const gone = await staleness(
    req,
    parsed.flatMap((x) => (x.p.success ? [x.p.data] : [])),
    fields,
  );
  for (const { r, p } of parsed) {
    if (!p.success || gone(p.data)) {
      counts[r.id] = null;
      continue;
    }
    try {
      const q = p.data.pipelineId || !byDefault ? p.data : { ...p.data, pipelineId: byDefault.id };
      const hits = await resolveSearch(req, q, fields);
      if (hits?.capped) capped.push(r.id);
      parts.push({
        id: r.id,
        where: and(...leadFilters(req, q, fields, hits))!,
        ...(countable(q) ? { counted: q as FilterQuery & { pipelineId: string } } : {}),
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      counts[r.id] = null;
    }
  }
  // Each view on its own (7A): one pass with a FILTER per view had to read every lead; alone, each takes its own
  // index, and one filtered only by pipeline, owner or stage reads the kept counts.
  for (const p of parts) {
    if (p.counted) {
      counts[p.id] = (await countLeads(req, p.counted)).total;
      continue;
    }
    const { rows: out } = await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM leads WHERE ${p.where}`,
    );
    counts[p.id] = out[0]?.n ?? 0;
  }
  return { counts, capped };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Registry = Awaited<ReturnType<typeof loadFieldRegistry>>;

/**
 * Which filters name something no longer there (a stage, tag, lost reason or pipeline gone or archived, a
 * select option removed): such a view can't be counted as it was meant. Every view's ids are looked up
 * together, a question per kind, however many views there are (4B minor).
 */
async function staleness(
  req: FastifyRequest,
  all: FilterQuery[],
  fields: Registry,
): Promise<(q: FilterQuery) => boolean> {
  const ids = (pick: (q: FilterQuery) => (string | undefined)[]) => [
    ...new Set(all.flatMap(pick).filter((x): x is string => !!x && UUID.test(x))),
  ];
  const live = async (table: string, want: string[], extra = "") => {
    if (!want.length) return new Set<string>();
    const { rows } = await req.db.execute<{ id: string }>(
      // Drizzle spreads an array into a list of parameters: IN (…).
      sql`SELECT id FROM ${sql.identifier(table)} WHERE id IN ${want} ${sql.raw(extra)}`,
    );
    return new Set(rows.map((r) => r.id));
  };
  const stages = await live(
    "stages",
    ids((q) => q.stageId?.split(",") ?? []),
    "AND archived_at IS NULL",
  );
  const tags = await live(
    "tags",
    ids((q) => [q.tagId]),
  );
  const reasons = await live(
    "lost_reasons",
    ids((q) => [q.lostReasonId]),
    "AND archived_at IS NULL",
  );
  const pipelines = await live(
    "pipelines",
    ids((q) => [q.pipelineId]),
    "AND archived_at IS NULL",
  );
  const ok = (set: Set<string>, id: string | undefined) => !id || (UUID.test(id) && set.has(id));
  return (q) => {
    if (!(q.stageId?.split(",") ?? []).every((id) => ok(stages, id))) return true;
    if (!ok(tags, q.tagId) || !ok(reasons, q.lostReasonId) || !ok(pipelines, q.pipelineId)) return true;
    return customGone(q, fields);
  };
}

/** A select (or multi-select) filter naming an option the field no longer has. */
function customGone(q: FilterQuery, fields: Registry): boolean {
  if (!q.custom) return false;
  let filter: unknown;
  try {
    filter = JSON.parse(q.custom);
  } catch {
    return true;
  }
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  for (const [key, value] of Object.entries(filter)) {
    const def = fields.byKey.get(key);
    if (!def) return true;
    if ((def.type === "select" || def.type === "multi_select") && !def.options.some((o) => o.id === value))
      return true;
  }
  return false;
}

/** Filters that name something no longer there, for one view (a send queue planning from it, 4C). */
export async function stale(req: FastifyRequest, q: FilterQuery): Promise<boolean> {
  return (await staleness(req, [q], await loadFieldRegistry(req)))(q);
}
