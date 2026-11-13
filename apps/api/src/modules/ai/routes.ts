import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { PLAN_TIERS } from "@lume/core";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { catchUp, leadAi } from "./catch-up";
import { applyRead, dismissRead, suggestNextStep } from "./next-step";
import { getAiProfile, patchAiProfile } from "./profile";
import { askAboutPlan, aiStatus, requestTopUp, setAiEnabled } from "./service";
import { draftTemplates } from "../templates/draft";

/** LUME AI (spec 2026-10-18 §2.2): its status for anyone signed in, and its switch for admins. */
export async function aiRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/ai", { config: { permission: "auth.self" } }, (req) => aiStatus(req, d));
  // Ask the owner for more LUME AI this month (Autopilot spec 2026-10-19 §4): admins.
  r.post(
    "/api/v1/ai/topup",
    {
      config: { permission: "settings.manage" },
      schema: { body: z.object({ note: z.string().trim().max(500).optional() }).strict() },
    },
    (req) => requestTopUp(req, d, req.body.note),
  );
  // Ask LUME about a higher tier (Plans and pricing, November 2026): admins.
  r.post(
    "/api/v1/plan/ask",
    {
      config: { permission: "settings.manage" },
      schema: { body: z.object({ tier: z.enum(PLAN_TIERS) }).strict() },
    },
    (req) => askAboutPlan(req, d, req.body.tier),
  );
  // Settings → LUME AI (Autopilot spec 2026-10-19 §5): what it knows, its voice, the standing choices; admins. The body
  // is checked by the core schema in the service, so a refusal says what's wrong in words.
  r.get("/api/v1/ai/profile", { config: { permission: "settings.manage" } }, (req) => getAiProfile(req));
  // LUME AI writes templates (2026-10-31): two or three drafts from what the person asks for; whoever manages templates.
  r.post(
    "/api/v1/templates/draft",
    {
      config: { permission: "templates.manage", idempotent: false },
      schema: { body: z.object({ prompt: z.string().max(500) }).strict() },
    },
    (req) => draftTemplates(req, d, req.body),
  );
  r.patch(
    "/api/v1/ai/profile",
    { config: { permission: "settings.manage" }, schema: { body: z.record(z.string(), z.unknown()) } },
    (req) => patchAiProfile(req, req.body),
  );
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
