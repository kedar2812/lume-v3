import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { notFound } from "../../http/errors";
import { timezoneSchema } from "../../http/schemas";

const shape = (s: typeof schema.settings.$inferSelect) => ({
  businessName: s.businessName,
  timezone: s.timezone,
  currency: s.currency,
  defaultCountry: s.defaultCountryIso,
  weekStart: s.weekStart,
  industryPreset: s.industryPreset,
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/settings", { config: { permission: "auth.self" } }, async (req) => {
    const [s] = await req.db.select().from(schema.settings);
    if (!s) throw notFound();
    return shape(s);
  });
  r.patch(
    "/api/v1/settings",
    {
      config: { permission: "settings.manage" },
      schema: {
        body: z
          .object({
            businessName: z.string().trim().min(1).max(120),
            timezone: timezoneSchema,
            currency: z.string().regex(/^[A-Z]{3}$/),
            defaultCountry: z.string().regex(/^[A-Z]{2}$/),
            weekStart: z.number().int().min(0).max(6),
          })
          .partial()
          .strict(),
      },
    },
    async (req) => {
      const { defaultCountry, ...rest } = req.body;
      const [s] = await req.db
        .update(schema.settings)
        .set({ ...rest, ...(defaultCountry ? { defaultCountryIso: defaultCountry } : {}) })
        .where(eq(schema.settings.id, 1))
        .returning();
      await audit(req, { action: "settings.updated", entityType: "settings", entityId: "1", diff: req.body });
      return shape(s!);
    },
  );
}
