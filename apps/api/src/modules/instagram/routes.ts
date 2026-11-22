import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { igIgnore, igInboxPerson, igInboxView, igMakeLead } from "./inbox";
import { leadInstagram } from "./thread";
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

  // A lead's Instagram conversations (§4.6): seen with the lead, the handle masked as the lead's is.
  r.get(
    "/api/v1/leads/:id/instagram",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => leadInstagram(req, req.params.id, d.clock()),
  );
  // Not a lead yet (§4.3): the account's owner and whoever sees every lead (row-level security decides).
  const thread = z.object({ threadId: z.uuid() });
  r.get(
    "/api/v1/instagram/inbox",
    {
      config: { permission: "auth.self" },
      schema: { querystring: z.object({ before: z.iso.datetime().optional() }).strict() },
    },
    (req) => igInboxView(req, req.query.before ?? null),
  );
  r.get(
    "/api/v1/instagram/inbox/:threadId",
    { config: { permission: "auth.self" }, schema: { params: thread } },
    (req) => igInboxPerson(req, req.params.threadId),
  );
  r.post(
    "/api/v1/instagram/inbox/:threadId/lead",
    { config: { permission: "leads.create" }, schema: { params: thread } },
    async (req, reply) => reply.code(201).send(await igMakeLead(req, req.params.threadId)),
  );
  r.post(
    "/api/v1/instagram/inbox/:threadId/ignore",
    { config: { permission: "auth.self" }, schema: { params: thread } },
    (req) => igIgnore(req, req.params.threadId),
  );
}
