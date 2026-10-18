import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { catchUp, leadAi } from "./catch-up";
import { applyRead, dismissRead, suggestNextStep } from "./next-step";
import { aiStatus, setAiEnabled } from "./service";

/** LUME AI (spec 2026-10-18 §2.2): its status for anyone signed in, and its switch for admins. */
export async function aiRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/ai", { config: { permission: "auth.self" } }, (req) => aiStatus(req, d));
  r.put(
    "/api/v1/integrations/ai",
    {
      config: { permission: "integrations.manage" },
      schema: { body: z.object({ enabled: z.boolean() }).strict() },
    },
    (req) => setAiEnabled(req, d, req.body.enabled),
  );
  const id = z.object({ id: z.uuid() });
  // A next step from a note or a logged call (§5.2): on a lead this person may edit.
  r.post(
    "/api/v1/leads/:id/ai/next-step",
    {
      config: { permission: "leads.edit" },
      schema: { params: id, body: z.object({ activityId: z.uuid() }).strict() },
    },
    (req) => suggestNextStep(req, d, req.params.id, req.body.activityId),
  );
  r.post(
    "/api/v1/ai/reads/:id/apply",
    {
      config: { permission: "leads.edit" },
      schema: {
        params: id,
        body: z.object({ stage: z.boolean(), followUp: z.boolean(), tags: z.boolean() }).strict(),
      },
    },
    (req) => applyRead(req, d, req.params.id, req.body),
  );
  // A lead's LUME AI: a catch-up to offer, a next step waiting (§5.3), and the catch-up itself, on request.
  r.get("/api/v1/leads/:id/ai", { config: { permission: "leads.view" }, schema: { params: id } }, (req) =>
    leadAi(req, d, req.params.id),
  );
  r.post(
    "/api/v1/leads/:id/ai/catch-up",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => catchUp(req, d, req.params.id),
  );
  r.post(
    "/api/v1/ai/reads/:id/dismiss",
    { config: { permission: "leads.edit" }, schema: { params: id } },
    (req) => dismissRead(req, req.params.id),
  );
}
