import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { badRequest } from "../../http/errors";
import { setFieldAccess } from "./field-access";
import * as roles from "./service";

const cfg = { permission: "roles.manage" as const };
const params = z.object({ id: z.uuid() });
const grant = z.object({
  key: z.string().regex(/^[a-z_.]+$/),
  scope: z.enum(["own", "team", "all"]).nullish(),
});
const role = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(240).optional(),
  color: z.enum(["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"]).optional(),
  grants: z.array(grant).max(100),
  // Named here only to be refused: see withoutAccess.
  loginHours: z.unknown().optional(),
  ipAllowlist: z.unknown().optional(),
});

/**
 * A role's sign-in hours and networks are Security's (security.manage), set through Settings → Security with its checks:
 * real times, hours that end after they start, and nobody locking themselves out (review 2026-10-25).
 */
function withoutAccess<T extends { loginHours?: unknown; ipAllowlist?: unknown }>(body: T) {
  const { loginHours, ipAllowlist, ...rest } = body;
  if (loginHours !== undefined || ipAllowlist !== undefined)
    throw badRequest("ACCESS_IN_SECURITY", "Sign-in hours and networks are set in Settings → Security.");
  return rest;
}

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/permissions", { config: cfg }, async () => roles.catalog());
  r.get("/api/v1/roles", { config: cfg }, (req) => roles.listRoles(req));
  r.get("/api/v1/roles/assignable", { config: { permission: "users.manage" } }, (req) =>
    roles.listAssignableRoles(req),
  );
  r.get("/api/v1/roles/:id", { config: cfg, schema: { params } }, (req) =>
    roles.readRole(req, req.params.id),
  );
  r.post("/api/v1/roles", { config: cfg, schema: { body: role } }, async (req, reply) =>
    reply.code(201).send(await roles.createRole(req, withoutAccess(req.body))),
  );
  r.patch("/api/v1/roles/:id", { config: cfg, schema: { params, body: role.partial() } }, (req) =>
    roles.updateRole(req, req.params.id, withoutAccess(req.body)),
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
  r.put(
    "/api/v1/roles/:id/field-access",
    {
      config: cfg,
      schema: {
        params,
        body: z.object({
          entries: z
            .array(z.object({ fieldId: z.uuid(), access: z.enum(["hidden", "view", "edit"]) }))
            .max(500),
        }),
      },
    },
    (req) => setFieldAccess(req, req.params.id, req.body.entries),
  );
}
