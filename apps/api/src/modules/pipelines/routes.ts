import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";

const manage = { permission: "pipelines.manage" as const };
const params = z.object({ id: z.uuid() });
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const stageBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["open", "won", "lost"]),
  color: z.enum(COLORS).optional(),
  winProbability: z.number().min(0).max(100).nullable().optional(),
  slaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullable()
    .optional(),
  requiredFieldIds: z.array(z.uuid()).max(30).optional(),
});

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/pipelines", { config: { permission: "leads.view" } }, (req) => svc.listPipelines(req));
  r.post(
    "/api/v1/pipelines",
    { config: manage, schema: { body: z.object({ name: z.string().trim().min(1).max(60) }) } },
    async (req, reply) => reply.code(201).send(await svc.createPipeline(req, req.body.name)),
  );
  r.patch(
    "/api/v1/pipelines/:id",
    {
      config: manage,
      schema: {
        params,
        body: z
          .object({
            name: z.string().trim().min(1).max(60).optional(),
            isDefault: z.literal(true).optional(),
            position: z.number().int().min(0).max(1000).optional(),
          })
          .strict(),
      },
    },
    (req) => svc.updatePipeline(req, req.params.id, req.body),
  );
  r.post("/api/v1/pipelines/:id/archive", { config: manage, schema: { params } }, async (req, reply) => {
    await svc.archivePipeline(req, req.params.id);
    return reply.code(204).send();
  });
  r.post(
    "/api/v1/pipelines/:id/stages",
    { config: manage, schema: { params, body: stageBody } },
    async (req, reply) => reply.code(201).send(await svc.createStage(req, req.params.id, req.body)),
  );
  r.put(
    "/api/v1/pipelines/:id/stage-order",
    { config: manage, schema: { params, body: z.object({ stageIds: z.array(z.uuid()).min(1).max(50) }) } },
    (req) => svc.reorderStages(req, req.params.id, req.body.stageIds),
  );
  r.patch(
    "/api/v1/stages/:id",
    { config: manage, schema: { params, body: stageBody.partial().strict() } },
    (req) => svc.updateStage(req, req.params.id, req.body),
  );
  r.post(
    "/api/v1/stages/:id/archive",
    { config: manage, schema: { params, body: z.object({ moveToStageId: z.uuid().optional() }) } },
    async (req, reply) => {
      await svc.archiveStage(req, req.params.id, req.body.moveToStageId);
      return reply.code(204).send();
    },
  );
}
