import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { filterQuerySchema } from "../leads/routes";
import { HttpError } from "../../http/errors";
import * as svc from "./service";
import { trace } from "./trace";

/** A file to trace is at most 10 MB, as an import is. */
const TRACE_BYTES = 10 * 1024 * 1024;
const fileNameOf = (raw: string | string[] | undefined) => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  try {
    return v ? decodeURIComponent(v) : "file.csv";
  } catch {
    return v ?? "file.csv";
  }
};

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
  // Scoped to this plugin: only Trace takes a raw file body.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: TRACE_BYTES },
    (_req, body, done) => done(null, body),
  );
  // Trace a file found outside the business, or a code typed from its LUME ref column (6B).
  r.post(
    "/api/v1/security/trace",
    { config: { permission: "security.manage", idempotent: false }, bodyLimit: TRACE_BYTES },
    async (req) => {
      if (Buffer.isBuffer(req.body))
        return trace(req, { file: req.body, fileName: fileNameOf(req.headers["x-file-name"]) });
      const code = (req.body as { code?: unknown } | null)?.code;
      if (typeof code !== "string")
        throw new HttpError(
          415,
          "UPLOAD_A_FILE",
          "Send the file itself, or a code from its LUME ref column.",
        );
      return trace(req, { code });
    },
  );
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
