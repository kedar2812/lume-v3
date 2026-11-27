import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { errorHandler, notFoundHandler } from "./errors";
import { healthRoutes, type ReadinessCheck } from "./health";
import { trackRouteDeclarations } from "./route-guard";

export type ServerDeps = {
  checks: Record<string, ReadinessCheck>;
  readinessTimeoutMs?: number;
  logger?: FastifyServerOptions["logger"];
  /** Instance-wide setup before any route (validator/serializer compilers). */
  configure?: (app: FastifyInstance) => void;
  /** Public routes with their own proof (webhooks): beside health, outside the session scope. */
  open?: (app: FastifyInstance) => void | Promise<void>;
  /** Feature modules register here (Phase 1+). */
  register?: (app: FastifyInstance) => void | Promise<void>;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  // LUME's own time on every answer (the connection notice, 2026-11-26): the browser takes it from the whole wait, so
  // only the trip to the person's device can ever read as their connection being slow.
  const started = new WeakMap<object, number>();
  app.addHook("onRequest", async (req) => {
    started.set(req.raw, performance.now());
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const at = started.get(req.raw);
    if (at !== undefined) reply.header("server-timing", `app;dur=${(performance.now() - at).toFixed(1)}`);
    return payload;
  });
  deps.configure?.(app);
  const assertDeclared = trackRouteDeclarations(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(healthRoutes(deps.checks, deps.readinessTimeoutMs ?? 2000));
  if (deps.open) await app.register(async (scope) => deps.open?.(scope));
  if (deps.register) await app.register(async (scope) => deps.register?.(scope));
  await app.ready();
  try {
    assertDeclared();
  } catch (e) {
    await app.close();
    throw e;
  }
  return app;
}
