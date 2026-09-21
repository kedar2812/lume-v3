import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { nameSchema, passwordInput, timezoneSchema, totpCodeSchema } from "../../http/schemas";
import * as me from "./service";

const self = { permission: "auth.self" as const };
/** Reachable before a mandatory 2FA enrolment is done — enrolling is how the user gets unstuck. */
const enrol = { permission: "auth.self" as const, allowDuringEnrolment: true };
const password = z.object({ password: passwordInput });

export async function meRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/v1/me/sessions", { config: self }, (req) => me.listSessions(req));
  r.delete(
    "/api/v1/me/sessions/:id",
    { config: self, schema: { params: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }) } },
    async (req, reply) => {
      await me.revokeMine(req, d, req.params.id);
      return reply.code(204).send();
    },
  );

  r.post("/api/v1/me/2fa/enrol", { config: enrol }, (req) => me.beginEnrolment(req, d));
  r.post(
    "/api/v1/me/2fa/confirm",
    { config: enrol, schema: { body: z.object({ code: totpCodeSchema }) } },
    (req, reply) => me.confirmEnrolment(req, reply, d, req.body.code),
  );
  r.post("/api/v1/me/2fa/disable", { config: self, schema: { body: password } }, (req, reply) =>
    me.disableTwoFactor(req, reply, d, req.body.password),
  );
  r.post("/api/v1/me/recovery-codes", { config: self, schema: { body: password } }, (req, reply) =>
    me.regenerateRecoveryCodes(req, reply, d, req.body.password),
  );

  r.patch(
    "/api/v1/me",
    {
      config: self,
      schema: {
        body: z
          .object({
            name: nameSchema.optional(),
            timezone: timezoneSchema.optional(),
            theme: z.enum(["system", "porcelain", "obsidian"]).optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateProfile(req, req.body),
  );
}
