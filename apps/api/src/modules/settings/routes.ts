import { eq, sql } from "drizzle-orm";
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
import { workingHoursSchema } from "@lume/core";
import { followUpsBody, readFollowUps, workingHoursFrom } from "./follow-ups";
import { messagingBody, readMessaging } from "./messaging";

const shape = (s: typeof schema.settings.$inferSelect) => ({
  businessName: s.businessName,
  timezone: s.timezone,
  currency: s.currency,
  defaultCountry: s.defaultCountryIso,
  weekStart: s.weekStart,
  industryPreset: s.industryPreset,
  workingHours: workingHoursFrom(s.workingHours),
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
            // The business's working week (3C): LUME's own follow-ups land inside it.
            workingHours: workingHoursSchema,
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
  // Follow-ups (3B, 3C): escalation, the morning email, leads gone quiet, working hours and time choices.
  // Each section is optional and changes on its own; what's stored is read over the defaults.
  r.get("/api/v1/settings/follow-ups", { config: { permission: "settings.manage" } }, (req) =>
    readFollowUps(req),
  );
  r.put(
    "/api/v1/settings/follow-ups",
    { config: { permission: "settings.manage" }, schema: { body: followUpsBody } },
    async (req) => {
      const before = await readFollowUps(req, { forUpdate: true });
      const next = { ...before, ...req.body };
      // Leads gone quiet, switched on: from now (what's already quiet doesn't all come back at once).
      if (req.body.noTouch) {
        const { enabled, days } = req.body.noTouch;
        const from = before.noTouch.enabled ? before.noTouch.from : new Date().toISOString();
        next.noTouch = { enabled, days, ...(enabled && from ? { from } : {}) };
      }
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
  // Messages (4C): the send queue's run size and the daily cap.
  r.get("/api/v1/settings/messaging", { config: { permission: "settings.manage" } }, (req) =>
    readMessaging(req),
  );
  r.put(
    "/api/v1/settings/messaging",
    { config: { permission: "settings.manage" }, schema: { body: messagingBody } },
    async (req) => {
      const next = { ...(await readMessaging(req, { forUpdate: true })), ...req.body };
      await req.db.update(schema.settings).set({ messaging: next }).where(eq(schema.settings.id, 1));
      await audit(req, {
        action: "settings.messaging",
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
