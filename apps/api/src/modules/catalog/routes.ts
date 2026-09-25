import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";
import { currencySchema } from "../../http/schemas";

const read = { permission: "leads.view" as const };
const pipelines = { permission: "pipelines.manage" as const };
const settings = { permission: "settings.manage" as const };
const params = z.object({ id: z.uuid() });
const label = z.string().trim().min(1).max(60);
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const product = z.object({
  name: z.string().trim().min(1).max(80),
  defaultValue: z.number().nonnegative().max(1e12).nullable().optional(),
  currency: currencySchema.nullable().optional(),
});

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/v1/lost-reasons", { config: read }, (req) => svc.listLostReasons(req));
  r.post(
    "/api/v1/lost-reasons",
    { config: pipelines, schema: { body: z.object({ label }) } },
    async (req, reply) => reply.code(201).send(await svc.createLostReason(req, req.body.label)),
  );
  r.patch(
    "/api/v1/lost-reasons/:id",
    {
      config: pipelines,
      schema: {
        params,
        body: z
          .object({ label: label.optional(), position: z.number().int().min(0).max(1000).optional() })
          .strict(),
      },
    },
    (req) => svc.updateLostReason(req, req.params.id, req.body),
  );
  r.post(
    "/api/v1/lost-reasons/:id/archive",
    { config: pipelines, schema: { params } },
    async (req, reply) => {
      await svc.archiveLostReason(req, req.params.id);
      return reply.code(204).send();
    },
  );

  r.get("/api/v1/tags", { config: read }, (req) => svc.listTags(req));
  r.post(
    "/api/v1/tags",
    { config: settings, schema: { body: z.object({ label, color: z.enum(COLORS).optional() }) } },
    async (req, reply) => reply.code(201).send(await svc.createTag(req, req.body)),
  );
  r.patch(
    "/api/v1/tags/:id",
    {
      config: settings,
      schema: {
        params,
        body: z.object({ label: label.optional(), color: z.enum(COLORS).optional() }).strict(),
      },
    },
    (req) => svc.updateTag(req, req.params.id, req.body),
  );
  r.delete("/api/v1/tags/:id", { config: settings, schema: { params } }, async (req, reply) => {
    await svc.deleteTag(req, req.params.id);
    return reply.code(204).send();
  });

  r.get("/api/v1/products", { config: read }, (req) => svc.listProducts(req));
  r.post("/api/v1/products", { config: settings, schema: { body: product } }, async (req, reply) =>
    reply.code(201).send(await svc.createProduct(req, req.body)),
  );
  r.patch(
    "/api/v1/products/:id",
    { config: settings, schema: { params, body: product.partial().strict() } },
    (req) => svc.updateProduct(req, req.params.id, req.body),
  );
  r.post("/api/v1/products/:id/archive", { config: settings, schema: { params } }, async (req, reply) => {
    await svc.archiveProduct(req, req.params.id);
    return reply.code(204).send();
  });
}
