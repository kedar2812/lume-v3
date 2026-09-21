import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requiresTwoFactor } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { clearSessionCookie } from "../../auth/cookies";
import { revokeSession } from "../../auth/sessions";
import { unauthorized } from "../../http/errors";
import { login, recoveryCode, secondFactor, type LockoutHook } from "./service";

const email = z.email().max(254);
const self = { permission: "auth.self" as const, allowDuringEnrolment: true };

export async function authRoutes(
  app: FastifyInstance,
  d: AppDeps & { onLockout?: LockoutHook },
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/auth/login",
    { config: { public: true }, schema: { body: z.object({ email, password: z.string().min(1).max(256) }) } },
    (req, reply) => login(req, reply, d, req.body.email, req.body.password, d.onLockout),
  );
  r.post(
    "/api/v1/auth/2fa",
    { config: { public: true }, schema: { body: z.object({ code: z.string().regex(/^\d{6}$/) }) } },
    (req, reply) => secondFactor(req, reply, d, req.body.code),
  );
  r.post(
    "/api/v1/auth/recovery",
    { config: { public: true }, schema: { body: z.object({ code: z.string().min(10).max(20) }) } },
    (req, reply) => recoveryCode(req, reply, d, req.body.code),
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
    };
  });
}
