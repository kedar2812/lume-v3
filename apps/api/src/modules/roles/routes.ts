import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as roles from "./service";

const cfg = { permission: "roles.manage" as const };
const params = z.object({ id: z.uuid() });
const grant = z.object({
  key: z.string().regex(/^[a-z_.]+$/),
  scope: z.enum(["own", "team", "all"]).nullish(),
});
const loginHours = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  from: z.string().regex(/^\d\d:\d\d$/),
  to: z.string().regex(/^\d\d:\d\d$/),
});
const role = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(240).optional(),
  color: z.enum(["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"]).optional(),
  grants: z.array(grant).max(100),
  loginHours: loginHours.nullish(),
  ipAllowlist: z.array(z.cidrv4().or(z.cidrv6())).max(50).nullish(),
});

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/permissions", { config: cfg }, async () => roles.catalog());
  r.get("/api/v1/roles", { config: cfg }, (req) => roles.listRoles(req));
  r.get("/api/v1/roles/:id", { config: cfg, schema: { params } }, (req) =>
    roles.readRole(req, req.params.id),
  );
  r.post("/api/v1/roles", { config: cfg, schema: { body: role } }, async (req, reply) =>
    reply.code(201).send(await roles.createRole(req, req.body)),
  );
  r.patch("/api/v1/roles/:id", { config: cfg, schema: { params, body: role.partial() } }, (req) =>
    roles.updateRole(req, req.params.id, req.body),
  );
  r.delete(
    "/api/v1/roles/:id",
    {
      config: cfg,
      schema: { params, body: z.object({ replacementRoleId: z.uuid().optional() }).optional() },
    },
    async (req, reply) => {
      await roles.deleteRole(req, req.params.id, req.body?.replacementRoleId);
      return reply.code(204).send();
    },
  );
  r.post(
    "/api/v1/roles/:id/clone",
    { config: cfg, schema: { params, body: z.object({ name: z.string().trim().min(1).max(60) }) } },
    async (req, reply) => reply.code(201).send(await roles.cloneRole(req, req.params.id, req.body.name)),
  );
}
