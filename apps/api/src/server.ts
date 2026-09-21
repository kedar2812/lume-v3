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
  deps.configure?.(app);
  const assertDeclared = trackRouteDeclarations(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(healthRoutes(deps.checks, deps.readinessTimeoutMs ?? 2000));
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
