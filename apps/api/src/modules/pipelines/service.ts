import { and, asc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors";

type StageRow = typeof schema.stages.$inferSelect;
export type StageInput = {
  name?: string;
  kind?: "open" | "won" | "lost";
  color?: string;
  winProbability?: number | null;
  slaHours?: number | null;
  requiredFieldIds?: string[];
};

const stageView = (s: StageRow) => ({
  id: s.id,
  name: s.name,
  color: s.color,
  position: s.position,
  kind: s.kind,
  winProbability: s.winProbability,
  slaHours: s.slaHours,
  requiredFieldIds: s.requiredFieldIds,
});

async function livePipeline(req: FastifyRequest, id: string) {
  const [p] = await req.db
    .select()
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.id, id), isNull(schema.pipelines.archivedAt)));
  if (!p) throw notFound("PIPELINE_NOT_FOUND", "Pipeline not found");
  return p;
}

async function liveStage(req: FastifyRequest, id: string) {
  const [s] = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.id, id), isNull(schema.stages.archivedAt)));
  if (!s) throw notFound("STAGE_NOT_FOUND", "Stage not found");
  return s;
}

const liveStages = (req: FastifyRequest, pipelineId: string) =>
  req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipelineId), isNull(schema.stages.archivedAt)))
    .orderBy(asc(schema.stages.position), asc(schema.stages.createdAt));

async function pipelineView(req: FastifyRequest, id: string) {
  const p = await livePipeline(req, id);
  return {
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    position: p.position,
    stages: (await liveStages(req, id)).map(stageView),
  };
}

/** Anything that must account for every lead needs to see every lead (RLS would silently hide some). */
function assertFullVisibility(req: FastifyRequest) {
  if (scopeOf(req.actor!, "leads.view") !== "all") {
    throw forbidden("NEEDS_FULL_VISIBILITY", "This needs access to all leads");
  }
}

function assertKinds(stages: { kind: string }[]) {
  const kinds = new Set(stages.map((s) => s.kind));
  if (!kinds.has("won") || !kinds.has("lost"))
    throw badRequest("STAGE_KINDS_REQUIRED", "A pipeline needs at least one Won and one Lost stage");
}

async function assertFieldsExist(req: FastifyRequest, ids: string[] | undefined) {
  if (!ids?.length) return;
  const found = await req.db
    .select({ id: schema.fieldDefinitions.id })
    .from(schema.fieldDefinitions)
    .where(and(inArray(schema.fieldDefinitions.id, ids), isNull(schema.fieldDefinitions.archivedAt)));
  if (found.length !== new Set(ids).size)
    throw badRequest("UNKNOWN_FIELD", "One of those fields doesn't exist");
}

export async function listPipelines(req: FastifyRequest) {
  const ps = await req.db
    .select()
    .from(schema.pipelines)
    .where(isNull(schema.pipelines.archivedAt))
    .orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt));
  const out = [];
  for (const p of ps) out.push(await pipelineView(req, p.id)); // one connection: sequential
  return { pipelines: out };
}

export async function createPipeline(req: FastifyRequest, name: string) {
  const [dup] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.name, name), isNull(schema.pipelines.archivedAt)));
  if (dup) throw conflict("PIPELINE_EXISTS", "A pipeline with that name already exists");
  const [hasDefault] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.isDefault, true), isNull(schema.pipelines.archivedAt)));
  const [{ top } = { top: null }] = await req.db
    .select({ top: max(schema.pipelines.position) })
    .from(schema.pipelines);
  const id = newId();
  await req.db
    .insert(schema.pipelines)
    .values({ id, name, isDefault: !hasDefault, position: (top ?? -1) + 1 });
  await req.db.insert(schema.stages).values([
    {
      id: newId(),
      pipelineId: id,
      name: "New",
      kind: "open",
      color: "accent",
      position: 0,
      winProbability: 10,
    },
    { id: newId(), pipelineId: id, name: "Won", kind: "won", color: "ok", position: 1, winProbability: 100 },
    {
      id: newId(),
      pipelineId: id,
      name: "Lost",
      kind: "lost",
      color: "danger",
      position: 2,
      winProbability: 0,
    },
  ]);
  await audit(req, { action: "pipeline.created", entityType: "pipeline", entityId: id, diff: { name } });
  return { pipeline: await pipelineView(req, id) };
}

export async function updatePipeline(
  req: FastifyRequest,
  id: string,
  patch: { name?: string; isDefault?: boolean; position?: number },
) {
  const p = await livePipeline(req, id);
  if (patch.isDefault === false && p.isDefault)
    throw badRequest("DEFAULT_PIPELINE", "Make another pipeline the default instead");
  if (patch.isDefault)
    await req.db
      .update(schema.pipelines)
      .set({ isDefault: false })
      .where(and(eq(schema.pipelines.isDefault, true), ne(schema.pipelines.id, id)));
  if (Object.keys(patch).length)
    await req.db.update(schema.pipelines).set(patch).where(eq(schema.pipelines.id, id));
  await audit(req, { action: "pipeline.updated", entityType: "pipeline", entityId: id, diff: patch });
  return { pipeline: await pipelineView(req, id) };
}

export async function archivePipeline(req: FastifyRequest, id: string) {
  const p = await livePipeline(req, id);
  if (p.isDefault) throw badRequest("DEFAULT_PIPELINE", "The default pipeline can't be archived");
  assertFullVisibility(req);
  const [{ n }] = (
    await req.db.execute(
      sql`SELECT count(*)::int AS n FROM leads WHERE pipeline_id = ${id} AND deleted_at IS NULL`,
    )
  ).rows as [{ n: number }];
  if (n > 0) throw conflict("PIPELINE_HAS_LEADS", `Move its ${n} leads first`);
  const now = new Date();
  await req.db
    .update(schema.stages)
    .set({ archivedAt: now })
    .where(and(eq(schema.stages.pipelineId, id), isNull(schema.stages.archivedAt)));
  await req.db.update(schema.pipelines).set({ archivedAt: now }).where(eq(schema.pipelines.id, id));
  await audit(req, { action: "pipeline.archived", entityType: "pipeline", entityId: id });
}

export async function createStage(
  req: FastifyRequest,
  pipelineId: string,
  input: StageInput & { name: string; kind: "open" | "won" | "lost" },
) {
  await livePipeline(req, pipelineId);
  await assertFieldsExist(req, input.requiredFieldIds);
  const current = await liveStages(req, pipelineId);
  if (current.some((s) => s.name.toLowerCase() === input.name.toLowerCase()))
    throw conflict("STAGE_EXISTS", "A stage with that name already exists");
  const id = newId();
  await req.db.insert(schema.stages).values({
    id,
    pipelineId,
    position: current.length ? Math.max(...current.map((s) => s.position)) + 1 : 0,
    ...input,
  });
  await audit(req, {
    action: "stage.created",
    entityType: "stage",
    entityId: id,
    diff: { pipelineId, name: input.name, kind: input.kind },
  });
  return { stage: stageView(await liveStage(req, id)) };
}

export async function updateStage(req: FastifyRequest, id: string, patch: StageInput) {
  const s = await liveStage(req, id);
  await assertFieldsExist(req, patch.requiredFieldIds);
  if (patch.kind && patch.kind !== s.kind) {
    const others = (await liveStages(req, s.pipelineId)).map((x) =>
      x.id === id ? { kind: patch.kind! } : x,
    );
    assertKinds(others);
  }
  if (Object.keys(patch).length)
    await req.db.update(schema.stages).set(patch).where(eq(schema.stages.id, id));
  await audit(req, { action: "stage.updated", entityType: "stage", entityId: id, diff: patch });
  return { stage: stageView(await liveStage(req, id)) };
}

export async function reorderStages(req: FastifyRequest, pipelineId: string, stageIds: string[]) {
  const current = await liveStages(req, pipelineId);
  const want = new Set(stageIds);
  if (
    want.size !== stageIds.length ||
    current.length !== stageIds.length ||
    current.some((s) => !want.has(s.id))
  ) {
    throw badRequest("STAGE_ORDER_INCOMPLETE", "List every active stage of the pipeline exactly once");
  }
  for (const [i, sid] of stageIds.entries())
    await req.db.update(schema.stages).set({ position: i }).where(eq(schema.stages.id, sid));
  await audit(req, {
    action: "stage.reordered",
    entityType: "pipeline",
    entityId: pipelineId,
    diff: { stageIds },
  });
  return { pipeline: await pipelineView(req, pipelineId) };
}

export async function archiveStage(req: FastifyRequest, id: string, moveToStageId?: string) {
  const s = await liveStage(req, id);
  const siblings = await liveStages(req, s.pipelineId);
  assertKinds(siblings.filter((x) => x.id !== id));
  assertFullVisibility(req);
  const [{ n }] = (
    await req.db.execute(
      sql`SELECT count(*)::int AS n FROM leads WHERE stage_id = ${id} AND deleted_at IS NULL`,
    )
  ).rows as [{ n: number }];
  if (n > 0) {
    if (!moveToStageId) throw badRequest("MOVE_TARGET_REQUIRED", `Choose where its ${n} leads should go`);
    const target = siblings.find((x) => x.id === moveToStageId);
    if (!target || target.id === id || target.kind !== "open") {
      throw badRequest("MOVE_TARGET_INVALID", "Move leads to another open stage of the same pipeline");
    }
    const actorId = req.actor!.userId;
    // History first, while the leads still sit in the old stage; then move them.
    await req.db.execute(sql`
      INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_by)
      SELECT id, stage_id, ${target.id}, pipeline_id, ${actorId} FROM leads WHERE stage_id = ${id} AND deleted_at IS NULL`);
    await req.db.execute(sql`
      UPDATE leads SET stage_id = ${target.id}, stage_entered_at = now(), version = version + 1
       WHERE stage_id = ${id} AND deleted_at IS NULL`);
  }
  await req.db.update(schema.stages).set({ archivedAt: new Date() }).where(eq(schema.stages.id, id));
  await audit(req, {
    action: "stage.archived",
    entityType: "stage",
    entityId: id,
    diff: { movedLeads: n, moveToStageId: moveToStageId ?? null },
  });
}
