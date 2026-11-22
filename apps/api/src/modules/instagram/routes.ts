import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  accountsView,
  connectComplete,
  connectStart,
  disconnect,
  setAccount,
  setInstagramSettings,
} from "./service";

/** Instagram (NEW_FEATURES_PLAN §4): the module switch, connecting accounts and whose each is — admins only. */
export async function instagramRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const manage = { config: { permission: "integrations.manage" as const } };
  const id = z.object({ id: z.uuid() });
  r.put(
    "/api/v1/integrations/instagram",
    { ...manage, schema: { body: z.object({ enabled: z.boolean() }).strict() } },
    (req) => setInstagramSettings(req, d, req.body),
  );
  r.post("/api/v1/instagram/connect", manage, (req) => connectStart(req, d));
  r.post(
    "/api/v1/instagram/connect/complete",
    {
      ...manage,
      schema: { body: z.object({ p: z.string().min(1).max(8000), s: z.string().min(1).max(200) }).strict() },
    },
    (req) => connectComplete(req, d, req.body),
  );
  r.get("/api/v1/instagram/accounts", manage, (req) => accountsView(req));
  r.patch(
    "/api/v1/instagram/accounts/:id",
    {
      ...manage,
      schema: {
        params: id,
        body: z
          .object({ ownerId: z.uuid().nullable().optional(), newDmCreatesLead: z.boolean().optional() })
          .strict()
          .refine((b) => b.ownerId !== undefined || b.newDmCreatesLead !== undefined, "Nothing to change."),
      },
    },
    (req) => setAccount(req, req.params.id, req.body),
  );
  r.delete("/api/v1/instagram/accounts/:id", { ...manage, schema: { params: id } }, (req) =>
    disconnect(req, d, req.params.id),
  );
}
