import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  createWebhook,
  createWebhookDraft,
  dismissEvent,
  getWebhook,
  listWebhooks,
  patchWebhook,
  removeWebhook,
  retryEvent,
  rotateSecret,
  saveWebhook,
  setWebhooksEnabled,
  testPost,
} from "./service";

const manage = { permission: "integrations.manage" as const };
const params = z.object({ id: z.uuid() });
const eventParams = z.object({ id: z.uuid(), eventId: z.coerce.number().int().min(1) });
const name = z.string().trim().min(1).max(120);

/** 2C spec §7: setting up and looking after webhooks (receiving is receive.ts, outside the session scope). */
export async function webhookRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.put(
    "/api/v1/integrations/webhooks",
    { config: manage, schema: { body: z.object({ enabled: z.boolean() }).strict() } },
    (req) => setWebhooksEnabled(req, d, req.body.enabled),
  );
  r.post(
    "/api/v1/webhooks/sources",
    {
      config: { ...manage, idempotent: false },
      schema: {
        body: z.object({ preset: z.enum(["website", "zapier", "make", "manychat"]), name }).strict(),
      },
    },
    async (req, reply) => reply.code(201).send(await createWebhook(req, d, req.body)),
  );
  r.get("/api/v1/webhooks/sources", { config: manage }, (req) => listWebhooks(req, d));
  r.get("/api/v1/webhooks/sources/:id", { config: manage, schema: { params } }, (req) =>
    getWebhook(req, d, req.params.id),
  );
  r.get("/api/v1/webhooks/sources/:id/test", { config: manage, schema: { params } }, async (req, reply) => {
    const t = await testPost(req, d, req.params.id);
    return t ? t : reply.code(204).send();
  });
  r.post(
    "/api/v1/webhooks/sources/:id/draft",
    { config: { ...manage, idempotent: false }, schema: { params } },
    async (req, reply) => reply.code(201).send(await createWebhookDraft(req, d, req.params.id)),
  );
  r.post(
    "/api/v1/webhooks/sources/:id/save",
    {
      config: manage,
      schema: { params, body: z.object({ importId: z.uuid(), keepTest: z.boolean() }).strict() },
    },
    (req) => saveWebhook(req, d, req.params.id, req.body),
  );
  r.patch(
    "/api/v1/webhooks/sources/:id",
    {
      config: manage,
      schema: { params, body: z.object({ name: name.optional(), paused: z.boolean().optional() }).strict() },
    },
    (req) => patchWebhook(req, d, req.params.id, req.body),
  );
  // Never replayed or stored for replay: the answer is a secret (final review, Important 4).
  r.post(
    "/api/v1/webhooks/sources/:id/rotate",
    { config: { ...manage, idempotent: false }, schema: { params } },
    (req) => rotateSecret(req, d, req.params.id),
  );
  r.post(
    "/api/v1/webhooks/sources/:id/events/:eventId/retry",
    { config: manage, schema: { params: eventParams } },
    async (req, reply) => {
      await retryEvent(req, d, req.params.id, req.params.eventId);
      return reply.code(202).send({ queued: true });
    },
  );
  r.post(
    "/api/v1/webhooks/sources/:id/events/:eventId/dismiss",
    { config: manage, schema: { params: eventParams } },
    async (req, reply) => {
      await dismissEvent(req, req.params.id, req.params.eventId);
      return reply.code(204).send();
    },
  );
  r.delete("/api/v1/webhooks/sources/:id", { config: manage, schema: { params } }, async (req, reply) => {
    await removeWebhook(req, req.params.id);
    return reply.code(204).send();
  });
}
