import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { newTotpSecret, otpauthUri, safeEqual } from "@lume/core";
import type { AppDeps } from "../../app";
import { forbidden } from "../../http/errors";
import { runSetup } from "./service";

const tz = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");

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
            name: z.string().trim().min(1).max(120),
            timezone: tz,
            currency: z.string().regex(/^[A-Z]{3}$/),
            defaultCountry: z.string().regex(/^[A-Z]{2}$/),
          }),
          preset: z.enum(["coaching", "general"]),
          owner: z.object({
            name: z.string().trim().min(1).max(120),
            email: z.email().max(254),
            password: z.string().min(1).max(256),
          }),
          totp: z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), code: z.string().regex(/^\d{6}$/) }),
        }),
      },
    },
    (req, reply) => runSetup(req, reply, d, req.body),
  );
}
