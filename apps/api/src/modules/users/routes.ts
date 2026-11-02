import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { passwordInput, totpCodeSchema } from "../../http/schemas";
import { badRequest } from "../../http/errors";
import { deleteAccount } from "./delete";
import { leadsChoiceSchema, offboard, offboardingPreview } from "./offboard";
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
  // Offboarding (6C): what it would do, then the act itself, in this request's one transaction.
  r.get("/api/v1/users/:id/offboarding", { config: cfg, schema: { params } }, (req) =>
    offboardingPreview(req, d, req.params.id),
  );
  r.post(
    "/api/v1/users/:id/offboard",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({
            leads: z.discriminatedUnion("to", [
              z.object({ to: z.literal("person"), userId: z.uuid() }).strict(),
              z.object({ to: z.literal("team"), teamId: z.uuid() }).strict(),
              z.object({ to: z.literal("none") }).strict(),
            ]),
          })
          .strict(),
      },
    },
    (req) => offboard(req, d, req.params.id, req.body.leads),
  );
  // Delete someone's account (spec 2026-11-02): an admin, with their own password (and code); never themselves here
  // (that's My account), never the business owner.
  r.post(
    "/api/v1/users/:id/delete",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({ leads: leadsChoiceSchema, password: passwordInput, code: totpCodeSchema.optional() })
          .strict(),
      },
    },
    async (req, reply) => {
      if (req.params.id === req.actor!.userId)
        throw badRequest("USE_MY_ACCOUNT", "Delete your own account from My account");
      if (await deleteAccount(req, reply, d, req.params.id, req.body)) return reply.code(204).send();
      return reply;
    },
  );
  r.delete("/api/v1/users/:id/sessions", { config: cfg, schema: { params } }, async (req, reply) => {
    await users.killSessions(req, d, req.params.id);
    return reply.code(204).send();
  });
}
