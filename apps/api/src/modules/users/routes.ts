import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import * as users from "./service";

const params = z.object({ id: z.uuid() });
const cfg = { permission: "users.manage" as const };

export async function userRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/users", { config: cfg }, (req) => users.listUsers(req));
  r.patch(
    "/api/v1/users/:id",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            roleIds: z.array(z.uuid()).max(20).optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      await users.updateUser(req, req.params.id, req.body);
      return reply.code(204).send();
    },
  );
  r.post(
    "/api/v1/users/:id/disable",
    {
      config: cfg,
      schema: { params, body: z.object({ reassignTo: z.uuid().nullable().optional() }).nullish() },
    },
    async (req, reply) => {
      await users.setDisabled(req, d, req.params.id, true, req.body?.reassignTo);
      return reply.code(204).send();
    },
  );
  r.post("/api/v1/users/:id/enable", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.setDisabled(req, d, req.params.id, false);
    return reply.code(204).send();
  });
  r.delete("/api/v1/users/:id/sessions", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.killSessions(req, d, req.params.id);
    return reply.code(204).send();
  });
}
