import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  // Follow-ups (3B): when an overdue follow-up reaches the people who manage its assignee.
  // Each section is optional and changes on its own; what's stored is read over the defaults.
  const followUps = z
    .object({
      escalation: z.object({ enabled: z.boolean(), hours: z.number().int().min(1).max(168) }).strict(),
      // The morning email, for the whole business (an optional module: 3B final review, Important 8).
      digest: z.object({ enabled: z.boolean() }).strict(),
    })
    .partial()
    .strict();
  const FOLLOW_UP_DEFAULTS = { escalation: { enabled: true, hours: 24 }, digest: { enabled: true } };
  const readFollowUps = async (req: FastifyRequest) => {
    const [s] = await req.db.select({ f: schema.settings.followUps }).from(schema.settings);
    if (!s) throw notFound();
    return { ...FOLLOW_UP_DEFAULTS, ...(s.f as object) } as typeof FOLLOW_UP_DEFAULTS;
  };
  r.get("/api/v1/settings/follow-ups", { config: { permission: "settings.manage" } }, (req) =>
    readFollowUps(req),
  );
  r.put(
    "/api/v1/settings/follow-ups",
    { config: { permission: "settings.manage" }, schema: { body: followUps } },
    async (req) => {
      const before = await readFollowUps(req);
      const next = { ...before, ...req.body };
      await req.db.update(schema.settings).set({ followUps: next }).where(eq(schema.settings.id, 1));
      // Switched on, escalation starts from now: what was already overdue doesn't flood managers at once
      // (3B final review). Anything moved or snoozed from here on is watched as usual.
      if (!before.escalation.enabled && next.escalation.enabled)
        await req.db.execute(
          sql`UPDATE tasks SET escalated_at = now() WHERE status = 'open' AND escalated_at IS NULL AND due_at < now()`,
        );
      await audit(req, {
        action: "settings.follow_ups",
        entityType: "settings",
        entityId: "1",
        diff: req.body,
      });
      return next;
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
