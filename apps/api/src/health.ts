import type { FastifyInstance } from "fastify";
import type pg from "pg";

export type ReadinessCheck = () => Promise<unknown>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function healthRoutes(checks: Record<string, ReadinessCheck>, timeoutMs: number) {
  return async (app: FastifyInstance) => {
    app.get("/healthz", { config: { public: true } }, async () => ({ status: "ok" }));
    app.get("/readyz", { config: { public: true } }, async (_req, reply) => {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await withTimeout(check(), timeoutMs);
            return [name, "ok"] as const;
          } catch {
            return [name, "fail"] as const;
          }
        }),
      );
      const ok = results.every(([, s]) => s === "ok");
      return reply
        .code(ok ? 200 : 503)
        .send({ status: ok ? "ok" : "unavailable", checks: Object.fromEntries(results) });
    });
  };
}

/** Readiness as the API's own DB role: the database answers and the queue schema is visible. */
export function dbChecks(pool: pg.Pool): Record<string, ReadinessCheck> {
  return {
    database: () => pool.query("SELECT 1"),
    queue: () => pool.query("SELECT version FROM pgboss.version"),
  };
}
