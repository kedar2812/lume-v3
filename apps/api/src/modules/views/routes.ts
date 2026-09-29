import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as svc from "./service";

const see = { permission: "leads.view" as const };
const params = z.object({ id: z.uuid() });
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const fields = {
  name: z.string().trim().min(1).max(40),
  color: z.enum(COLORS),
  filters: z.record(z.string().max(40), z.string().max(2000)),
  sharedRoleIds: z.array(z.uuid()).max(50),
};

/** Saved views (Phase 4B): the leads worth a person's time, under a name, with a live count. */
export async function viewRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/views", { config: see }, (req) => svc.listViews(req));
  r.get("/api/v1/views/counts", { config: see }, (req) => svc.viewCounts(req));
  r.post(
    "/api/v1/views",
    {
      config: see,
      schema: { body: z.object({ ...fields, sharedRoleIds: fields.sharedRoleIds.optional() }).strict() },
    },
    async (req, reply) => reply.code(201).send(await svc.createView(req, req.body)),
  );
  r.put(
    "/api/v1/views/order",
    { config: see, schema: { body: z.object({ ids: z.array(z.uuid()).max(200) }).strict() } },
    (req) => svc.orderViews(req, req.body.ids),
  );
  r.patch(
    "/api/v1/views/:id",
    { config: see, schema: { params, body: z.object(fields).partial().strict() } },
    (req) => svc.updateView(req, req.params.id, req.body),
  );
  r.delete("/api/v1/views/:id", { config: see, schema: { params } }, async (req, reply) => {
    await svc.deleteView(req, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/v1/views/:id/restore", { config: see, schema: { params } }, (req) =>
    svc.restoreView(req, req.params.id),
  );
}
