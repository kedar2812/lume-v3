import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { ignorePeer, inboxPerson, inboxView, makeLead } from "./inbox";
import { mediaInfo, sendMedia } from "./media";
import { leadThread } from "./thread";
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

  // A lead's WhatsApp thread, for the drawer (§4.2): seen with the lead.
  r.get(
    "/api/v1/leads/:id/whatsapp",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => leadThread(req, req.params.id),
  );
  // A file on a lead, or waiting in Not a lead yet: row-level security decides who sees it (§4.1).
  r.get(
    "/api/v1/whatsapp/media/:id",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req, reply) => sendMedia(req, reply, req.params.id),
  );
  r.get(
    "/api/v1/whatsapp/media/:id/info",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => mediaInfo(req, req.params.id),
  );
  // Not a lead yet (§4.1): the number's owner and whoever sees every lead (row-level security decides).
  const person = z.object({ numberId: z.uuid(), peer: z.string().regex(/^\+\d{6,16}$/) });
  r.get("/api/v1/whatsapp/inbox", { config: { permission: "auth.self" } }, (req) => inboxView(req));
  r.get(
    "/api/v1/whatsapp/inbox/:numberId/:peer",
    { config: { permission: "auth.self" }, schema: { params: person } },
    (req) => inboxPerson(req, req.params.numberId, req.params.peer),
  );
  r.post(
    "/api/v1/whatsapp/inbox/:numberId/:peer/lead",
    { config: { permission: "leads.create" }, schema: { params: person } },
    async (req, reply) => reply.code(201).send(await makeLead(req, req.params.numberId, req.params.peer)),
  );
  r.post(
    "/api/v1/whatsapp/inbox/:numberId/:peer/ignore",
    { config: { permission: "auth.self" }, schema: { params: person } },
    (req) => ignorePeer(req, req.params.numberId, req.params.peer),
  );
}
