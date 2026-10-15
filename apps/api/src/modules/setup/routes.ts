import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { newTotpSecret, otpauthUri, safeEqual } from "@lume/core";
import type { AppDeps } from "../../app";
import { forbidden, HttpError, notFound, tooMany } from "../../http/errors";
import { createLimiter } from "../webhooks/limits";
import {
  countrySchema,
  currencySchema,
  emailSchema,
  nameSchema,
  passwordInput,
  timezoneSchema,
  totpCodeSchema,
} from "../../http/schemas";
import { runSetup } from "./service";

export async function setupRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // One read, no transaction: holding a request transaction while asking the same pool for this query
  // deadlocked the API under a burst of page loads (every connection held, each waiting for another).
  r.get("/api/v1/setup/status", { config: { public: true, db: false } }, async () => {
    const { rows } = await d.pool.query<{ has_users: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM users) AS has_users",
    );
    if (rows[0]!.has_users) return { needsSetup: false };
    d.setupTokens.ensure(); // a wiped installation can still be set up; the token is printed again
    // A client's install starts with the product key instead of the token (spec 2026-10-15 §1.1).
    return { needsSetup: true, needsKey: app.licence.needsKey() };
  });

  // Until a key is approved, the setup token opens nothing on an install that asks for one (spec 2026-10-15 §1.1).
  const keyFirst = () => {
    if (app.licence.needsKey() && app.licence.keySource() === null)
      throw forbidden("KEY_FIRST", "Enter this LUME's product key first");
  };

  // The product key (spec 2026-10-15 §1.1, §4.1): ten tries an hour from one address, sixty in all. Approval hands
  // the setup token to this browser only; every later step takes it as before.
  const tries = createLimiter({ perSource: 10, perInstance: 60, windowMs: 3_600_000 });
  r.post(
    "/api/v1/setup/key",
    { config: { public: true }, schema: { body: z.object({ key: z.string().min(1).max(128) }).strict() } },
    async (req) => {
      if (!app.licence.needsKey()) throw notFound("NO_KEY_NEEDED", "This LUME doesn't ask for a product key");
      const { rows } = await d.pool.query<{ has_users: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM users) AS has_users",
      );
      if (rows[0]!.has_users) throw forbidden("SETUP_DONE", "LUME is already set up");
      for (const t of [tries.source(req.ip), tries.instance()]) if (!t.ok) throw tooMany(t.retryAfterSec);
      const r = await app.licence.activate(req.body.key);
      if (!r.ok)
        throw new HttpError(422, "KEY_REFUSED", "That product key wasn't approved", { reason: r.reason });
      return {
        token: d.setupTokens.ensure(),
        licence: {
          licenseType: r.view.licenseType,
          paidUntil: r.view.paidUntil,
          trialEndsAt: r.view.trialEndsAt,
        },
      };
    },
  );
  r.post(
    "/api/v1/setup/totp",
    { config: { public: true }, schema: { body: z.object({ token: z.string().min(1).max(128) }) } },
    async (req) => {
      keyFirst();
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
            currency: currencySchema,
            defaultCountry: countrySchema,
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
    (req, reply) => {
      keyFirst();
      return runSetup(req, reply, d, req.body);
    },
  );
}
