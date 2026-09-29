import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";

const manage = { permission: "templates.manage" as const };
const params = z.object({ id: z.uuid() });
const CATEGORIES = ["first_touch", "follow_up", "reminder", "re_engagement", "custom"] as const;
const fields = {
  name: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORIES),
  body: z.string().trim().min(1).max(4096),
  allowedRoleIds: z.array(z.uuid()).max(50),
};

/** WhatsApp templates (Phase 4A; report §11.1): write once, use everywhere; each edit a new version. */
export async function templateRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/templates", { config: { permission: "templates.use" } }, (req) => svc.listTemplates(req));
  r.post(
    "/api/v1/templates",
    {
      config: manage,
      schema: { body: z.object({ ...fields, allowedRoleIds: fields.allowedRoleIds.optional() }).strict() },
    },
    async (req, reply) => reply.code(201).send(await svc.createTemplate(req, req.body)),
  );
  r.put(
    "/api/v1/templates/order",
    { config: manage, schema: { body: z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict() } },
    (req) => svc.reorderTemplates(req, req.body.ids),
  );
  r.patch(
    "/api/v1/templates/:id",
    { config: manage, schema: { params, body: z.object(fields).partial().strict() } },
    (req) => svc.updateTemplate(req, req.params.id, req.body),
  );
  r.post("/api/v1/templates/:id/archive", { config: manage, schema: { params } }, (req) =>
    svc.archiveTemplate(req, req.params.id),
  );
  r.post("/api/v1/templates/:id/restore", { config: manage, schema: { params } }, (req) =>
    svc.restoreTemplate(req, req.params.id),
  );
}
