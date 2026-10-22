import {
  defaultGoalStages,
  mergeAiProfile,
  profileProblem,
  type AiProfile,
  type AiProfilePatch,
} from "@lume/core";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError } from "../../http/errors";

/** Settings → LUME AI as the page reads it: the profile, and the business's things it names, in their words. */
export type AiProfileView = {
  profile: AiProfile;
  /** The business currency: every price in the price list is in it. */
  currency: string;
  /** Open stages of every pipeline in use, for goals (the default pipeline first). */
  stages: { id: string; name: string; pipeline: string }[];
  /** The files chosen for LUME AI to send, by name; an archived one is said, so it can be removed. */
  files: { id: string; name: string; archived: boolean }[];
  /** Who LUME AI may speak as: active people who may send messages. */
  speakers: { id: string; name: string }[];
};

const refuse = (message: string) => new HttpError(400, "INVALID_PROFILE", message);

async function openStages(req: FastifyRequest) {
  return req.db
    .select({
      id: schema.stages.id,
      name: schema.stages.name,
      afterReplyStageId: schema.stages.afterReplyStageId,
      pipelineId: schema.stages.pipelineId,
      pipeline: schema.pipelines.name,
    })
    .from(schema.stages)
    .innerJoin(schema.pipelines, eq(schema.pipelines.id, schema.stages.pipelineId))
    .where(
      and(
        eq(schema.stages.kind, "open"),
        isNull(schema.stages.archivedAt),
        isNull(schema.pipelines.archivedAt),
      ),
    )
    .orderBy(desc(schema.pipelines.isDefault), asc(schema.pipelines.position), asc(schema.stages.position));
}
type Stage = Awaited<ReturnType<typeof openStages>>[number];

/** Before anything is saved: the defaults, with ready-made goal stages from each pipeline (§1.1), up to five. */
function firstProfile(stages: Stage[]): AiProfile {
  const byPipeline = new Map<string, Stage[]>();
  for (const s of stages) byPipeline.set(s.pipelineId, [...(byPipeline.get(s.pipelineId) ?? []), s]);
  const goals = [...byPipeline.values()].flatMap((ss) => defaultGoalStages(ss)).slice(0, 5);
  return mergeAiProfile(null, { standing: { goalStages: goals } });
}

async function speakers(req: FastifyRequest): Promise<{ id: string; name: string }[]> {
  const { rows } = await req.db.execute<{ id: string; name: string }>(sql`
    SELECT u.id, u.name FROM users u
     WHERE u.status = 'active' AND (u.is_owner OR EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = u.id AND rp.permission_key = 'messages.send'))
     ORDER BY u.name`);
  return rows;
}

async function filesOf(req: FastifyRequest, ids: string[]) {
  if (!ids.length) return [];
  const rows = await req.db
    .select({
      id: schema.messageFiles.id,
      name: schema.messageFiles.name,
      archivedAt: schema.messageFiles.archivedAt,
    })
    .from(schema.messageFiles)
    .where(inArray(schema.messageFiles.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const f = byId.get(id);
    return f ? [{ id, name: f.name, archived: f.archivedAt !== null }] : [];
  });
}

async function storedProfile(req: FastifyRequest, stages: Stage[], lock: boolean): Promise<AiProfile> {
  const q = req.db
    .select({ profile: schema.aiProfile.profile })
    .from(schema.aiProfile)
    .where(eq(schema.aiProfile.id, 1));
  const [row] = lock ? await q.for("update") : await q;
  return row ? mergeAiProfile(row.profile, {}) : firstProfile(stages);
}

async function viewOf(req: FastifyRequest, profile: AiProfile, stages: Stage[]): Promise<AiProfileView> {
  const [s] = await req.db
    .select({ currency: schema.settings.currency })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return {
    profile,
    currency: s?.currency ?? "USD",
    stages: stages.map((x) => ({ id: x.id, name: x.name, pipeline: x.pipeline })),
    files: await filesOf(req, profile.knows.files),
    speakers: await speakers(req),
  };
}

/** `GET /api/v1/ai/profile` (admins). */
export async function getAiProfile(req: FastifyRequest): Promise<AiProfileView> {
  const stages = await openStages(req);
  return viewOf(req, await storedProfile(req, stages, false), stages);
}

/**
 * `PATCH /api/v1/ai/profile` (admins): a partial profile, merged onto what's saved, under a row lock so two admins
 * saving different sections at once both keep theirs. What it names must be the business's own: files in Media (one
 * archived since it was chosen may stay, to be removed; it can't be chosen anew), open stages, people who may message.
 */
export async function patchAiProfile(req: FastifyRequest, body: unknown): Promise<AiProfileView> {
  const problem = profileProblem(body);
  if (problem) throw refuse(problem);
  const patch = body as AiProfilePatch;
  const stages = await openStages(req);
  await req.db
    .insert(schema.aiProfile)
    .values({ id: 1, profile: firstProfile(stages) })
    .onConflictDoNothing();
  const current = await storedProfile(req, stages, true);

  const files = patch.knows?.files;
  if (files) {
    const known = new Map((await filesOf(req, files)).map((f) => [f.id, f]));
    for (const id of files) {
      const f = known.get(id);
      if (!f) throw refuse("A file chosen for LUME AI isn't in Media.");
      if (f.archived && !current.knows.files.includes(id))
        throw refuse("That file is archived in Media. Restore it to choose it.");
    }
  }
  const goals = patch.standing?.goalStages;
  if (goals && goals.some((g) => !stages.some((s) => s.id === g)))
    throw refuse("A goal is one of your open stages.");
  const speaker = patch.standing?.speaker;
  if (speaker && !(await speakers(req)).some((p) => p.id === speaker))
    throw refuse("LUME AI can only speak as someone who may send messages.");

  const next = mergeAiProfile(current, patch);
  await req.db
    .update(schema.aiProfile)
    .set({ profile: next, updatedAt: new Date(), updatedBy: req.actor!.userId })
    .where(eq(schema.aiProfile.id, 1));
  const sections = (["knows", "voice", "standing"] as const).filter((k) => patch[k] !== undefined);
  // Which sections changed, never the words: what a business knows and says is its own.
  await audit(req, { action: "ai_profile.updated", entityType: "settings", diff: { sections } });
  return viewOf(req, next, stages);
}
