import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { calendlyView, connectCalendly, disconnectCalendly, patchCalendly } from "./service";

const manage = { permission: "integrations.manage" as const };

/** Settings → Integrations → Calendly (5B): the business's Calendly, connected by an admin. */
export async function calendlyRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/integrations/calendly", { config: manage }, (req) => calendlyView(req, d));
  r.post(
    "/api/v1/integrations/calendly",
    {
      config: { ...manage, idempotent: false },
      schema: { body: z.object({ token: z.string().trim().min(10).max(2000) }).strict() },
    },
    (req) => connectCalendly(req, d, req.body.token),
  );
  r.patch(
    "/api/v1/integrations/calendly",
    {
      config: manage,
      schema: {
        body: z
          .object({
            createLeads: z.boolean().optional(),
            rescheduleFollowUp: z.boolean().optional(),
            phoneQuestion: z.string().max(200).nullable().optional(),
          })
          .strict(),
      },
    },
    (req) => patchCalendly(req, d, req.body),
  );
  r.delete("/api/v1/integrations/calendly", { config: manage }, (req) => disconnectCalendly(req, d));
}
