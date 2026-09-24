import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ONBOARDING_STEPS, preferencesPatchSchema, type OnboardingStepId } from "@lume/core";
import type { AppDeps } from "../../app";
import { nameSchema, passwordInput, timezoneSchema, totpCodeSchema } from "../../http/schemas";
import * as me from "./service";

const self = { permission: "auth.self" as const };
/** Reachable before a mandatory 2FA enrolment is done — enrolling is how the user gets unstuck. */
const enrol = { permission: "auth.self" as const, allowDuringEnrolment: true };
const password = z.object({ password: passwordInput });
const stepIds = ONBOARDING_STEPS.map((s) => s.id) as [OnboardingStepId, ...OnboardingStepId[]];

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
            preferences: preferencesPatchSchema.optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateProfile(req, req.body),
  );
  // Reachable during a required two-step enrolment: onboarding drives that step itself.
  r.put(
    "/api/v1/me/onboarding",
    {
      config: enrol,
      schema: {
        body: z
          .object({
            step: z.enum(stepIds).nullable().optional(),
            skip: z.enum(stepIds).optional(),
            completed: z.literal(true).optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateOnboarding(req, req.body),
  );
  r.put(
    "/api/v1/me/tour",
    {
      config: self,
      schema: {
        body: z
          .object({
            step: z.number().int().min(0).max(100).optional(),
            completed: z.literal(true).optional(),
            skipped: z.literal(true).optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateTour(req, req.body),
  );
}
