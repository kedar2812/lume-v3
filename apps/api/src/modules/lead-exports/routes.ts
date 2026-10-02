import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { filterQuerySchema } from "../leads/routes";
import * as svc from "./service";

const params = z.object({ id: z.uuid() });
const exportBody = z.object({
  format: z.enum(["csv", "xlsx"]),
  label: z.string().trim().min(1).max(80),
  filters: filterQuerySchema.partial(),
  columns: z.array(z.string().regex(/^(custom:)?[a-z0-9_]{1,64}$/)).max(60),
});

/** Lead exports you can trace (6B): make one from the current view, list them, download your own. */
export async function leadExportRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/api/v1/leads/export",
    { config: { permission: "leads.export", idempotent: false }, schema: { body: exportBody } },
    async (req, reply) =>
      reply.code(201).send(await svc.makeExport(req, d.keyring, req.body as svc.ExportInput)),
  );
  r.get("/api/v1/leads/exports", { config: { permission: "security.manage" } }, (req) =>
    svc.listExports(req),
  );
  r.get(
    "/api/v1/leads/exports/:id/download",
    { config: { permission: "leads.export" }, schema: { params } },
    (req, reply) => svc.downloadExport(req, reply, d.keyring, req.params.id),
  );
}
