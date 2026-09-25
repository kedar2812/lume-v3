import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { emailSchema, nameSchema, passwordInput, urlTokenSchema } from "../../http/schemas";
import { acceptInvite, createInvite, listInvites, peekInvite, resendInvite, revokeInvite } from "./service";

const token = z.object({ token: urlTokenSchema });
const byId = z.object({ id: z.uuid() });

export async function inviteRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/api/v1/invites",
    {
      config: { permission: "users.manage" },
      schema: {
        body: z.object({ email: emailSchema, name: nameSchema, roleIds: z.array(z.uuid()).max(20) }),
      },
    },
    async (req, reply) => reply.code(201).send(await createInvite(req, d, req.body)),
  );
  r.get("/api/v1/invites", { config: { permission: "users.manage" } }, (req) => listInvites(req, d));
  r.post(
    "/api/v1/invites/:id/resend",
    { config: { permission: "users.manage" }, schema: { params: byId } },
    async (req, reply) => {
      await resendInvite(req, d, req.params.id);
      return reply.code(204).send();
    },
  );
  r.delete(
    "/api/v1/invites/:id",
    { config: { permission: "users.manage" }, schema: { params: byId } },
    async (req, reply) => {
      await revokeInvite(req, d, req.params.id);
      return reply.code(204).send();
    },
  );
  r.get("/api/v1/invites/:token", { config: { public: true }, schema: { params: token } }, (req) =>
    peekInvite(req, d, req.params.token),
  );
  r.post(
    "/api/v1/invites/:token/accept",
    { config: { public: true }, schema: { params: token, body: z.object({ password: passwordInput }) } },
    (req, reply) => acceptInvite(req, reply, d, req.params.token, req.body.password),
  );
}
