import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  LEGAL_VERSION,
  mergePreferences,
  needsAgreement,
  needsOnboarding,
  needsTour,
  requiresTwoFactor,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { clearSessionCookie } from "../../auth/cookies";
import { revokeSession } from "../../auth/sessions";
import { CAPABILITIES } from "../../capabilities";
import { unauthorized } from "../../http/errors";
import { onboardingOf, tourOf } from "../me/service";
import { emailSchema as email, passwordInput, totpCodeSchema, urlTokenSchema } from "../../http/schemas";
import { forgotPassword, resetPassword } from "./password";
import { login, recoveryCode, secondFactor, type LockoutHook } from "./service";

const self = { permission: "auth.self" as const, allowDuringEnrolment: true };

export async function authRoutes(
  app: FastifyInstance,
  d: AppDeps & { onLockout?: LockoutHook },
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/auth/login",
    { config: { public: true }, schema: { body: z.object({ email, password: passwordInput }) } },
    (req, reply) => login(req, reply, d, req.body.email, req.body.password, d.onLockout),
  );
  r.post(
    "/api/v1/auth/2fa",
    { config: { public: true }, schema: { body: z.object({ code: totpCodeSchema }) } },
    (req, reply) => secondFactor(req, reply, d, req.body.code),
  );
  r.post(
    "/api/v1/auth/recovery",
    { config: { public: true }, schema: { body: z.object({ code: z.string().min(10).max(20) }) } },
    (req, reply) => recoveryCode(req, reply, d, req.body.code),
  );

  r.post(
    "/api/v1/auth/password/forgot",
    { config: { public: true }, schema: { body: z.object({ email }) } },
    async (req, reply) => {
      await forgotPassword(req, d, req.body.email);
      return reply.code(202).send();
    },
  );
  r.post(
    "/api/v1/auth/password/reset",
    {
      config: { public: true },
      schema: { body: z.object({ token: urlTokenSchema, password: passwordInput }) },
    },
    async (req, reply) => {
      await resetPassword(req, d, req.body.token, req.body.password);
      return reply.code(204).send();
    },
  );

  r.post("/api/v1/auth/logout", { config: self }, async (req, reply) => {
    await revokeSession(req.db, req.session!.id, "logout", d.clock());
    await audit(req, { action: "user.logout", entityType: "user", entityId: req.actor!.userId });
    clearSessionCookie(reply, d.config.cookieSecure);
    return reply.code(204).send();
  });

  r.get("/api/v1/auth/me", { config: self }, async (req) => {
    const a = req.actor!;
    const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, a.userId));
    if (!u) throw unauthorized();
    const onboarding = onboardingOf(u);
    const tour = tourOf(u);
    return {
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        isOwner: u.isOwner,
        theme: u.theme,
        timezone: u.timezone,
      },
      permissions: [...a.perms.entries()]
        .map(([key, scope]) => ({ key, scope: scope === true ? null : scope }))
        .sort((x, y) => x.key.localeCompare(y.key)),
      twoFactor: { enabled: a.twoFactorEnabled, required: requiresTwoFactor(a) },
      preferences: mergePreferences(u.preferences, {}),
      onboarding,
      tour,
      capabilities: CAPABILITIES,
      agreement: { version: u.agreedVersion ?? null, current: LEGAL_VERSION },
      flags: {
        // The licence agreement, terms and privacy policy come before everything, onboarding included.
        needsAgreement: needsAgreement(u.agreedVersion),
        needsOnboarding: needsOnboarding(onboarding),
        needsTwoFactorEnrolment: requiresTwoFactor(a) && !a.twoFactorEnabled,
        // Onboarding itself offers the tour, so the tour is only outstanding on its own afterwards.
        needsTour: !needsOnboarding(onboarding) && needsTour(tour),
      },
    };
  });
}
