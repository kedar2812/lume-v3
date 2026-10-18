import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
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
}
