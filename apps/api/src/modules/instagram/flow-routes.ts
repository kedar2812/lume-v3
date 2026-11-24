import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { flowGraphSchema, flowStepsSchema } from "@lume/core";
import {
  FLOW_TEMPLATES,
  archiveFlow,
  createFlow,
  duplicateFlow,
  flowView,
  flowsView,
  publishFlow,
  saveDraft,
  setFlowStatus,
  setTriggers,
  type TemplateKey,
} from "./flow-admin";
import type { AppDeps } from "../../app";
import { aiBuildFlow } from "./flow-ai";
import { flowStats } from "./flow-stats";
import { flowPeople, flowVersions, leadRuns, restoreVersion, testKeyword } from "./flow-history";

/** Flows (NEW_FEATURES_PLAN §4.5; plan 1B Task 3): whoever may manage Instagram flows. */
export async function instagramFlowRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const manage = { config: { permission: "instagram.flows.manage" as const } };
  const id = z.object({ id: z.uuid() });
  const rev = z.number().int().min(1);
  const keyword = z.string().max(100);
  const trigger = z
    .object({
      kind: z.enum(["comment", "dm", "story_reply", "story_mention", "ad", "welcome"]),
      accountId: z.uuid().nullable(),
      keywords: z.array(keyword).max(50),
      mode: z.enum(["word", "exact", "any"]),
      mediaIds: z.array(z.string().regex(/^\d{1,40}$/)).max(50),
      adIds: z.array(z.string().regex(/^\d{1,40}$/)).max(50),
      publicReplies: z.array(z.string().max(300)).max(10),
      cooldownHours: z.number().int().min(0).max(720),
      enabled: z.boolean(),
    })
    .strict();

  r.get("/api/v1/instagram/flows", manage, (req) => flowsView(req));
  r.get("/api/v1/instagram/flows/templates", manage, () => ({
    templates: Object.entries(FLOW_TEMPLATES).map(([key, t]) => ({ key, name: t.name })),
  }));
  r.post(
    "/api/v1/instagram/flows",
    {
      ...manage,
      schema: {
        body: z
          .object({
            name: z.string().max(200),
            template: z.enum(Object.keys(FLOW_TEMPLATES) as [TemplateKey, ...TemplateKey[]]).optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => reply.code(201).send(await createFlow(req, req.body)),
  );
  r.get("/api/v1/instagram/flows/:id", { ...manage, schema: { params: id } }, (req) =>
    flowView(req, req.params.id),
  );
  r.put(
    "/api/v1/instagram/flows/:id",
    {
      ...manage,
      schema: {
        params: id,
        body: z
          .object({
            rev,
            name: z.string().max(200).optional(),
            steps: flowStepsSchema.optional(),
            /** The builder's form: a graph replaces the draft whole (a 1B list or an earlier graph). */
            graph: flowGraphSchema.optional(),
            priority: z.number().int().min(-1000).max(1000).optional(),
          })
          .strict()
          .refine((b) => !(b.steps && b.graph), "Send steps or a graph, not both."),
      },
    },
    (req) => saveDraft(req, req.params.id, req.body),
  );
  r.put(
    "/api/v1/instagram/flows/:id/triggers",
    {
      ...manage,
      schema: { params: id, body: z.object({ rev, triggers: z.array(trigger).max(20) }).strict() },
    },
    (req) => setTriggers(req, req.params.id, req.body),
  );
  r.post(
    "/api/v1/instagram/flows/:id/publish",
    { ...manage, schema: { params: id, body: z.object({ rev }).strict() } },
    (req) => publishFlow(req, req.params.id, req.body),
  );
  r.post(
    "/api/v1/instagram/flows/:id/status",
    { ...manage, schema: { params: id, body: z.object({ rev, to: z.enum(["paused", "live"]) }).strict() } },
    (req) => setFlowStatus(req, req.params.id, req.body),
  );
  r.post("/api/v1/instagram/flows/:id/archive", { ...manage, schema: { params: id } }, (req) =>
    archiveFlow(req, req.params.id),
  );
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  r.get(
    "/api/v1/instagram/flows/:id/stats",
    {
      ...manage,
      schema: {
        params: id,
        querystring: z
          .object({
            from: day.optional(),
            to: day.optional(),
            days: z.coerce.number().int().min(1).max(366).optional(),
          })
          .strict(),
      },
    },
    (req) => flowStats(req, req.params.id, req.query),
  );
  // Versions, one brought back, a lead's way through the flow, the keyword tester (plan 2026-11-23-flow-builder A3).
  r.get("/api/v1/instagram/flows/:id/versions", { ...manage, schema: { params: id } }, (req) =>
    flowVersions(req, req.params.id),
  );
  r.post(
    "/api/v1/instagram/flows/:id/versions/:versionId/restore",
    {
      ...manage,
      schema: { params: z.object({ id: z.uuid(), versionId: z.uuid() }), body: z.object({ rev }).strict() },
    },
    (req) => restoreVersion(req, req.params.id, req.params.versionId, req.body),
  );
  r.post(
    "/api/v1/instagram/flows/:id/ai-build",
    {
      ...manage,
      schema: {
        params: id,
        body: z
          .object({
            prompt: z.string().max(2000),
            selection: z.array(z.string().max(64)).max(100).optional(),
          })
          .strict(),
      },
    },
    (req) => aiBuildFlow(req, d, req.params.id, req.body),
  );
  r.get(
    "/api/v1/instagram/flows/:id/people",
    {
      ...manage,
      schema: { params: id, querystring: z.object({ q: z.string().max(100).optional() }).strict() },
    },
    (req) => flowPeople(req, req.params.id, req.query.q),
  );
  r.get(
    "/api/v1/instagram/flows/:id/runs",
    { ...manage, schema: { params: id, querystring: z.object({ lead: z.uuid() }).strict() } },
    (req) => leadRuns(req, req.params.id, req.query.lead),
  );
  r.post(
    "/api/v1/instagram/flows/test-keyword",
    {
      ...manage,
      schema: {
        body: z
          .object({
            text: z.string().max(1000),
            keywords: z.array(keyword).max(50),
            mode: z.enum(["word", "exact", "any"]),
            flowId: z.uuid().optional(),
          })
          .strict(),
      },
    },
    (req) => testKeyword(req, req.body),
  );
  r.post(
    "/api/v1/instagram/flows/:id/duplicate",
    {
      ...manage,
      schema: { params: id, body: z.object({ versionId: z.uuid().optional() }).strict().nullish() },
    },
    async (req, reply) => reply.code(201).send(await duplicateFlow(req, req.params.id, req.body?.versionId)),
  );
}
