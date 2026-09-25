import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { bumpFieldDefs } from "../../leads/fields";
import { badRequest, notFound } from "../../http/errors";
import type { AppDeps } from "../../app";
import { openErApi } from "../../money/rates";
import { quoteCurrency, switchCurrency } from "./service";
import { countrySchema, currencySchema, timezoneSchema } from "../../http/schemas";

const shape = (s: typeof schema.settings.$inferSelect) => ({
  businessName: s.businessName,
  timezone: s.timezone,
  currency: s.currency,
  defaultCountry: s.defaultCountryIso,
  weekStart: s.weekStart,
  industryPreset: s.industryPreset,
});

export async function settingsRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const rates = d.rates ?? openErApi();
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Readable before a required two-step enrolment is done: onboarding shows the business name throughout.
  r.get(
    "/api/v1/settings",
    { config: { permission: "auth.self", allowDuringEnrolment: true } },
    async (req) => {
      const [s] = await req.db.select().from(schema.settings);
      if (!s) throw notFound();
      return shape(s);
    },
  );
  r.patch(
    "/api/v1/settings",
    {
      config: { permission: "settings.manage" },
      schema: {
        body: z
          .object({
            businessName: z.string().trim().min(1).max(120),
            timezone: timezoneSchema,
            // Only through POST /settings/currency, which converts every amount (one currency, owner 2026-09-25).
            currency: z.string(),
            defaultCountry: countrySchema,
            weekStart: z.number().int().min(0).max(6),
          })
          .partial()
          .strict(),
      },
    },
    async (req) => {
      const { defaultCountry, currency, ...rest } = req.body;
      if (currency !== undefined)
        throw badRequest(
          "USE_DEDICATED_ENDPOINT",
          "Change the currency with Settings → Business, which converts every amount",
        );
      if (defaultCountry) await bumpFieldDefs(req); // compiled phone validators depend on it
      const [s] = await req.db
        .update(schema.settings)
        .set({ ...rest, ...(defaultCountry ? { defaultCountryIso: defaultCountry } : {}) })
        .where(eq(schema.settings.id, 1))
        .returning();
      await audit(req, { action: "settings.updated", entityType: "settings", entityId: "1", diff: req.body });
      return shape(s!);
    },
  );
  r.get(
    "/api/v1/settings/currency/quote",
    { config: { permission: "settings.manage" }, schema: { querystring: z.object({ to: currencySchema }) } },
    (req) => quoteCurrency(req, rates, req.query.to),
  );
  r.post(
    "/api/v1/settings/currency",
    {
      config: { permission: "settings.manage" },
      schema: {
        body: z
          .object({ from: currencySchema, to: currencySchema, rate: z.number().positive().max(1_000_000) })
          .strict(),
      },
    },
    (req) => switchCurrency(req, req.body),
  );
}
