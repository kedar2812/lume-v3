import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  connectComplete,
  connectStart,
  disconnect,
  numbersView,
  setOwner,
  setWhatsAppEnabled,
} from "./service";

/** WhatsApp (spec 2026-10-18 §3): the module switch, connecting numbers and whose each is — admins only. */
export async function whatsappRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const manage = { config: { permission: "integrations.manage" as const } };
  const id = z.object({ id: z.uuid() });
  r.put(
    "/api/v1/integrations/whatsapp",
    { ...manage, schema: { body: z.object({ enabled: z.boolean() }).strict() } },
    (req) => setWhatsAppEnabled(req, d, req.body.enabled),
  );
  r.post("/api/v1/whatsapp/connect", manage, (req) => connectStart(req, d));
  r.post(
    "/api/v1/whatsapp/connect/complete",
    {
      ...manage,
      schema: { body: z.object({ p: z.string().min(1).max(8000), s: z.string().min(1).max(200) }).strict() },
    },
    (req) => connectComplete(req, d, req.body),
  );
  r.get("/api/v1/whatsapp/numbers", manage, (req) => numbersView(req));
  r.patch(
    "/api/v1/whatsapp/numbers/:id",
    { ...manage, schema: { params: id, body: z.object({ ownerId: z.uuid().nullable() }).strict() } },
    (req) => setOwner(req, req.params.id, req.body.ownerId),
  );
  r.delete("/api/v1/whatsapp/numbers/:id", { ...manage, schema: { params: id } }, (req) =>
    disconnect(req, d, req.params.id),
  );
}
