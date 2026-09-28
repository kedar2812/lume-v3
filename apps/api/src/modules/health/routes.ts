import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { readHealth } from "./service";

/** Settings → System health (3C): is LUME keeping its promises? */
export async function healthRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  app.get("/api/v1/system/health", { config: { permission: "settings.manage" } }, () =>
    readHealth(d.pool, { ...(d.tasks?.lastSweepAt ? { lastSweepAt: d.tasks.lastSweepAt } : {}) }),
  );
}
