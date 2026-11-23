import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { INSTAGRAM_INTAKE } from "@lume/core";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { igIgnore, igInboxPerson, igInboxView, igMakeLead } from "./inbox";
import { leadInstagram } from "./thread";
import { sendLeadPhoto } from "./photo-route";
import { privateReply, sendInstagram, setTakeover } from "./send";
import { sendLimiter } from "../whatsapp/send";
import {
  accountsView,
  connectComplete,
  connectStart,
  disconnect,
  INTAKE_LIMITS,
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
          .object({
            ownerId: z.uuid().nullable().optional(),
            newDmCreatesLead: z.boolean().optional(),
            limits: z
              .object(
                Object.fromEntries(
                  INTAKE_LIMITS.map((k) => [
                    k,
                    z.number().int().min(INSTAGRAM_INTAKE[k].min).max(INSTAGRAM_INTAKE[k].max).optional(),
                  ]),
                ) as Record<(typeof INTAKE_LIMITS)[number], z.ZodOptional<z.ZodNumber>>,
              )
              .strict()
              .optional(),
          })
          .strict()
          .refine(
            (b) =>
              b.ownerId !== undefined ||
              b.newDmCreatesLead !== undefined ||
              (b.limits !== undefined && Object.values(b.limits).some((v) => v !== undefined)),
            "Nothing to change.",
          ),
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
  // Their Instagram profile photo (1B addendum): LUME's own copy, to whoever sees the lead's name.
  r.get(
    "/api/v1/leads/:id/photo",
    {
      config: { permission: "leads.view" },
      schema: { params: id, querystring: z.object({ v: z.string().max(64).optional() }).strict() },
    },
    (req, reply) => sendLeadPhoto(req, reply, d, req.params.id),
  );
  // Replying (§4.4): as anyone who may message the lead, 30 a minute and 600 an hour each.
  const limiter = sendLimiter({ now: d.clock });
  const quickReply = z
    .object({ title: z.string().min(1).max(60), payload: z.string().min(1).max(1000) })
    .strict();
  r.post(
    "/api/v1/leads/:id/instagram/messages",
    {
      config: { permission: "messages.send" },
      schema: {
        params: id,
        body: z
          .object({
            clientKey: z.uuid(),
            threadId: z.uuid(),
            text: z.string().min(1).max(4000),
            quickReplies: z.array(quickReply).max(20).optional(),
            retryOf: z.uuid().optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => reply.code(202).send(await sendInstagram(req, d, limiter, req.params.id, req.body)),
  );
  r.post(
    "/api/v1/instagram/comments/:id/private-reply",
    {
      config: { permission: "messages.send" },
      schema: {
        params: id,
        body: z.object({ clientKey: z.uuid(), text: z.string().min(1).max(4000) }).strict(),
      },
    },
    async (req, reply) => reply.code(202).send(await privateReply(req, d, limiter, req.params.id, req.body)),
  );
  r.post(
    "/api/v1/instagram/threads/:id/take-over",
    { config: { permission: "messages.send" }, schema: { params: id } },
    (req) => setTakeover(req, req.params.id, true),
  );
  r.post(
    "/api/v1/instagram/threads/:id/hand-back",
    { config: { permission: "messages.send" }, schema: { params: id } },
    (req) => setTakeover(req, req.params.id, false),
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
    { config: { permission: "leads.create" }, schema: { params: thread } },
    (req) => igIgnore(req, req.params.threadId),
  );
}
