import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { downloadPrepared, exportAll, prepareExport } from "./service";

/** Export all data (licensing L-A): allowed in every licence state (the guard's allowlist names it). */
export async function exportRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  app.get("/api/v1/export", { config: { permission: "data.export" } }, (req, reply) =>
    exportAll(req, reply, d.jobPool ?? d.pool),
  );
  app.post("/api/v1/export", { config: { permission: "data.export" } }, (req, reply) =>
    prepareExport(req, reply, d.jobPool ?? d.pool),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/export/:id",
    { config: { permission: "data.export" } },
    (req, reply) => downloadPrepared(req, reply),
  );
}
