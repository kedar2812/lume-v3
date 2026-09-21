import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { newTotpSecret, otpauthUri, safeEqual } from "@lume/core";
import type { AppDeps } from "../../app";
import { forbidden } from "../../http/errors";
import { emailSchema, nameSchema, passwordInput, timezoneSchema, totpCodeSchema } from "../../http/schemas";
import { runSetup } from "./service";

export async function setupRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/setup/status", { config: { public: true } }, async () => {
    const { rows } = await d.pool.query("SELECT EXISTS (SELECT 1 FROM users) AS has_users");
    return { needsSetup: !rows[0].has_users && d.setupTokens.current() !== null };
  });
  r.post(
    "/api/v1/setup/totp",
    { config: { public: true }, schema: { body: z.object({ token: z.string().min(1).max(128) }) } },
    async (req) => {
      const current = d.setupTokens.current();
      if (!current || !safeEqual(current, req.body.token))
        throw forbidden("SETUP_TOKEN", "That setup token isn't valid");
      const secret = newTotpSecret();
      return { secret, otpauthUri: otpauthUri({ secret, account: "owner", issuer: "LUME" }) };
    },
  );
  r.post(
    "/api/v1/setup",
    {
      config: { public: true },
      schema: {
        body: z.object({
          token: z.string().min(1).max(128),
          business: z.object({
            name: nameSchema,
            timezone: timezoneSchema,
            currency: z.string().regex(/^[A-Z]{3}$/),
            defaultCountry: z.string().regex(/^[A-Z]{2}$/),
          }),
          preset: z.enum(["coaching", "general"]),
          owner: z.object({
            name: nameSchema,
            email: emailSchema,
            password: passwordInput,
          }),
          totp: z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), code: totpCodeSchema }),
        }),
      },
    },
    (req, reply) => runSetup(req, reply, d, req.body),
  );
}
