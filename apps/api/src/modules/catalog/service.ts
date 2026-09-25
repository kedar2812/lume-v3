import { and, asc, eq, isNull, max, ne } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { conflict, notFound } from "../../http/errors";
import { assertOneCurrency } from "../settings/service";

// ── Lost reasons ───────────────────────────────────────────────────────────────
const reasonView = (r: typeof schema.lostReasons.$inferSelect) => ({
  id: r.id,
  label: r.label,
  position: r.position,
});

export async function listLostReasons(req: FastifyRequest) {
  const rows = await req.db
    .select()
    .from(schema.lostReasons)
    .where(isNull(schema.lostReasons.archivedAt))
    .orderBy(asc(schema.lostReasons.position));
  return { lostReasons: rows.map(reasonView) };
}

async function assertReasonLabelFree(req: FastifyRequest, label: string, exceptId?: string) {
  const [dup] = await req.db
    .select({ id: schema.lostReasons.id })
    .from(schema.lostReasons)
    .where(and(eq(schema.lostReasons.label, label), isNull(schema.lostReasons.archivedAt)));
  if (dup && dup.id !== exceptId) throw conflict("LOST_REASON_EXISTS", "That reason already exists");
}

export async function createLostReason(req: FastifyRequest, label: string) {
  await assertReasonLabelFree(req, label);
  const [{ top } = { top: null }] = await req.db
    .select({ top: max(schema.lostReasons.position) })
    .from(schema.lostReasons);
  const id = newId();
  const [row] = await req.db
    .insert(schema.lostReasons)
    .values({ id, label, position: (top ?? -1) + 1 })
    .returning();
  await audit(req, {
    action: "lost_reason.created",
    entityType: "lost_reason",
    entityId: id,
    diff: { label },
  });
  return { lostReason: reasonView(row!) };
}

export async function updateLostReason(
  req: FastifyRequest,
  id: string,
  patch: { label?: string; position?: number },
) {
  if (patch.label) await assertReasonLabelFree(req, patch.label, id);
  const [row] = await req.db
    .update(schema.lostReasons)
    .set(patch)
    .where(and(eq(schema.lostReasons.id, id), isNull(schema.lostReasons.archivedAt)))
    .returning();
  if (!row) throw notFound("LOST_REASON_NOT_FOUND", "Lost reason not found");
  await audit(req, { action: "lost_reason.updated", entityType: "lost_reason", entityId: id, diff: patch });
  return { lostReason: reasonView(row) };
}

export async function archiveLostReason(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .update(schema.lostReasons)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.lostReasons.id, id), isNull(schema.lostReasons.archivedAt)))
    .returning({ id: schema.lostReasons.id });
  if (!row) throw notFound("LOST_REASON_NOT_FOUND", "Lost reason not found");
  await audit(req, { action: "lost_reason.archived", entityType: "lost_reason", entityId: id });
}

// ── Tags ───────────────────────────────────────────────────────────────────────
const tagView = (t: typeof schema.tags.$inferSelect) => ({ id: t.id, label: t.label, color: t.color });

export async function listTags(req: FastifyRequest) {
  return { tags: (await req.db.select().from(schema.tags).orderBy(asc(schema.tags.label))).map(tagView) };
}

async function assertTagLabelFree(req: FastifyRequest, label: string, exceptId?: string) {
  const where = exceptId
    ? and(eq(schema.tags.label, label), ne(schema.tags.id, exceptId))
    : eq(schema.tags.label, label);
  const [dup] = await req.db.select({ id: schema.tags.id }).from(schema.tags).where(where);
  if (dup) throw conflict("TAG_EXISTS", "That tag already exists");
}

export async function createTag(req: FastifyRequest, input: { label: string; color?: string }) {
  await assertTagLabelFree(req, input.label);
  const id = newId();
  const [row] = await req.db
    .insert(schema.tags)
    .values({ id, ...input })
    .returning();
  await audit(req, { action: "tag.created", entityType: "tag", entityId: id, diff: input });
  return { tag: tagView(row!) };
}

export async function updateTag(req: FastifyRequest, id: string, patch: { label?: string; color?: string }) {
  if (patch.label) await assertTagLabelFree(req, patch.label, id);
  const [row] = await req.db.update(schema.tags).set(patch).where(eq(schema.tags.id, id)).returning();
  if (!row) throw notFound("TAG_NOT_FOUND", "Tag not found");
  await audit(req, { action: "tag.updated", entityType: "tag", entityId: id, diff: patch });
  return { tag: tagView(row) };
}

export async function deleteTag(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .delete(schema.tags)
    .where(eq(schema.tags.id, id))
    .returning({ id: schema.tags.id });
  if (!row) throw notFound("TAG_NOT_FOUND", "Tag not found");
  await audit(req, { action: "tag.deleted", entityType: "tag", entityId: id });
}

// ── Products ───────────────────────────────────────────────────────────────────
const productView = (p: typeof schema.products.$inferSelect) => ({
  id: p.id,
  name: p.name,
  defaultValue: p.defaultValue,
  currency: p.currency,
});
export type ProductInput = { name?: string; defaultValue?: number | null; currency?: string | null };

export async function listProducts(req: FastifyRequest) {
  const rows = await req.db
    .select()
    .from(schema.products)
    .where(isNull(schema.products.archivedAt))
    .orderBy(asc(schema.products.name));
  return { products: rows.map(productView) };
}

async function assertProductNameFree(req: FastifyRequest, name: string, exceptId?: string) {
  const [dup] = await req.db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(eq(schema.products.name, name), isNull(schema.products.archivedAt)));
  if (dup && dup.id !== exceptId) throw conflict("PRODUCT_EXISTS", "A product with that name already exists");
}

export async function createProduct(req: FastifyRequest, input: ProductInput & { name: string }) {
  await assertProductNameFree(req, input.name);
  await assertOneCurrency(req, input.currency);
  const id = newId();
  const [row] = await req.db
    .insert(schema.products)
    .values({ id, ...input, currency: null }) // always the business currency
    .returning();
  await audit(req, {
    action: "product.created",
    entityType: "product",
    entityId: id,
    diff: { name: input.name },
  });
  return { product: productView(row!) };
}

export async function updateProduct(req: FastifyRequest, id: string, patch: ProductInput) {
  if (patch.name) await assertProductNameFree(req, patch.name, id);
  await assertOneCurrency(req, patch.currency);
  if ("currency" in patch) patch = { ...patch, currency: null };
  const [row] = await req.db
    .update(schema.products)
    .set(patch)
    .where(and(eq(schema.products.id, id), isNull(schema.products.archivedAt)))
    .returning();
  if (!row) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
  await audit(req, {
    action: "product.updated",
    entityType: "product",
    entityId: id,
    diff: { fields: Object.keys(patch) },
  });
  return { product: productView(row) };
}

export async function archiveProduct(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .update(schema.products)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.products.id, id), isNull(schema.products.archivedAt)))
    .returning({ id: schema.products.id });
  if (!row) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
  await audit(req, { action: "product.archived", entityType: "product", entityId: id });
}
