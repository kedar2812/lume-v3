import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import * as svc from "./service";

const run = { permission: "messages.send_queue" as const };
const params = z.object({ id: z.uuid() });
const itemParams = z.object({ id: z.uuid(), pos: z.coerce.number().int().min(0).max(10_000) });

/** A refusal that keeps what it did (the daily cap pauses the run): answered, so the pause commits. */
function answer<T extends object>(reply: FastifyReply, out: T | svc.Refused) {
  if ("refused" in out) {
    const e = out.refused;
    return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
  }
  return out;
}

/** The send queue (Phase 4C): a person's run through a list of leads, one WhatsApp message each. */
export async function queueRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/api/v1/queues",
    {
      config: run,
      schema: {
        body: z.union([
          z.object({ viewId: z.uuid(), templateId: z.uuid().optional() }).strict(),
          z.object({ leadIds: z.array(z.uuid()).min(1).max(500), templateId: z.uuid().optional() }).strict(),
        ]),
      },
    },
    async (req, reply) => reply.code(201).send(await svc.startQueue(req, req.body)),
  );
  r.post(
    "/api/v1/queues/plan",
    {
      config: run,
      schema: {
        body: z.union([
          z.object({ viewId: z.uuid() }).strict(),
          z.object({ leadIds: z.array(z.uuid()).min(1).max(500) }).strict(),
        ]),
      },
    },
    (req) => svc.planQueue(req, req.body),
  );
  r.get("/api/v1/queues/current", { config: run }, (req) => svc.currentQueue(req));
  r.get("/api/v1/queues/:id", { config: run, schema: { params } }, (req) =>
    svc.queueView(req, req.params.id),
  );
  r.get("/api/v1/queues/:id/items/:pos/text", { config: run, schema: { params: itemParams } }, (req) =>
    svc.itemText(req, req.params.id, req.params.pos),
  );
  r.post(
    "/api/v1/queues/:id/items/:pos/prepare",
    {
      // Never kept for replay: the answer carries the wa.me link, with the number (final review #8).
      config: { ...run, idempotent: false },
      schema: { params: itemParams, body: z.object({ text: z.string().max(4096).optional() }).strict() },
    },
    async (req, reply) => {
      void reply.header("cache-control", "no-store");
      return answer(reply, await svc.prepareItem(req, req.params.id, req.params.pos, req.body));
    },
  );
  r.post("/api/v1/queues/:id/items/:pos/sent", { config: run, schema: { params: itemParams } }, (req) =>
    svc.answerItem(req, d, req.params.id, req.params.pos, true),
  );
  r.post("/api/v1/queues/:id/items/:pos/not-sent", { config: run, schema: { params: itemParams } }, (req) =>
    svc.answerItem(req, d, req.params.id, req.params.pos, false),
  );
  r.post("/api/v1/queues/:id/items/:pos/skip", { config: run, schema: { params: itemParams } }, (req) =>
    svc.skipItem(req, req.params.id, req.params.pos),
  );
  r.post("/api/v1/queues/:id/pause", { config: run, schema: { params } }, (req) =>
    svc.pauseQueue(req, req.params.id),
  );
  r.post("/api/v1/queues/:id/resume", { config: run, schema: { params } }, async (req, reply) =>
    answer(reply, await svc.resumeQueue(req, req.params.id)),
  );
  r.post("/api/v1/queues/:id/cancel", { config: run, schema: { params } }, (req) =>
    svc.cancelQueue(req, req.params.id),
  );
}
