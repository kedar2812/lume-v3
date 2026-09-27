import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { INTAKE_LIMITS } from "@lume/core";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import {
  discardImport,
  getDraft,
  getImport,
  listImports,
  patchImport,
  previewImport,
  uploadImport,
  type ImportPatch,
} from "./service";

const cfg = { permission: "leads.import" as const };
const params = z.object({ id: z.uuid() });
// Mapping and rules are checked in depth by validateMapping (with reasons the screen shows); here only
// their outline, so nothing malformed is stored.
const mapping = z.object({
  columns: z
    .array(
      z.looseObject({
        column: z
          .number()
          .int()
          .min(0)
          .max(INTAKE_LIMITS.columns - 1),
        to: z.enum(["ignore", "field", "name_part", "new_field"]),
      }),
    )
    .max(INTAKE_LIMITS.columns),
  createMissingTags: z.boolean(),
  addOptions: z.record(z.string(), z.array(z.string().trim().min(1).max(60)).max(100)).optional(),
});
const rules = z.object({
  matchOn: z.array(z.enum(["phone", "email", "instagram"])).max(3),
  onMatch: z.enum(["merge", "skip", "duplicate"]),
  reopenClosedTo: z.uuid().nullable(),
  pipelineId: z.uuid(),
  stageId: z.uuid(),
  owner: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("unassigned") }),
    z.object({ mode: z.literal("user"), userId: z.uuid() }),
    z.object({ mode: z.literal("round_robin"), userIds: z.array(z.uuid()).max(200) }),
  ]),
  defaultCountry: z.string().length(2).nullable(),
  noName: z.enum(["use_contact", "error"]),
  unknownOwner: z.enum(["fallback", "error"]),
  requiredDefaults: z.record(z.string(), z.unknown()),
});

/** The file's name travels URI-encoded in a header (the body is the file itself). */
function fileNameOf(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return "import.csv";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function importRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Scoped to this plugin: only the upload route takes a raw body.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: INTAKE_LIMITS.bytes + 1 },
    (_req, body, done) => done(null, body),
  );
  r.post(
    "/api/v1/imports",
    { config: { ...cfg, idempotent: false }, bodyLimit: INTAKE_LIMITS.bytes + 1 },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body))
        throw new HttpError(415, "UPLOAD_A_FILE", "Send the CSV file itself (application/octet-stream).");
      return reply
        .code(201)
        .send(await uploadImport(req, d, req.body, fileNameOf(req.headers["x-file-name"])));
    },
  );
  r.get("/api/v1/imports/:id/draft", { config: cfg, schema: { params } }, (req) =>
    getDraft(req, d, req.params.id),
  );
  r.patch(
    "/api/v1/imports/:id",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({
            encoding: z.enum(["utf-8", "utf-16le", "utf-16be", "windows-1252"]).optional(),
            delimiter: z.enum([",", ";", "\t", "|"]).optional(),
            headerRow: z.number().int().min(1).max(INTAKE_LIMITS.headerSearch).optional(),
            mapping: mapping.optional(),
            rules: rules.optional(),
          })
          .strict(),
      },
    },
    (req) => patchImport(req, d, req.params.id, req.body as ImportPatch),
  );
  r.post(
    "/api/v1/imports/:id/preview",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({
            rows: z.array(z.number().int().min(1)).max(INTAKE_LIMITS.previewRows).optional(),
            errorsOnly: z.boolean().optional(),
          })
          .strict(),
      },
    },
    (req) => previewImport(req, d, req.params.id, req.body),
  );
  r.delete("/api/v1/imports/:id", { config: cfg, schema: { params } }, async (req, reply) => {
    await discardImport(req, req.params.id);
    return reply.code(204).send();
  });
  r.get(
    "/api/v1/imports",
    { config: cfg, schema: { querystring: z.object({ cursor: z.uuid().optional() }) } },
    (req) => listImports(req, req.query.cursor),
  );
  r.get("/api/v1/imports/:id", { config: cfg, schema: { params } }, (req) => getImport(req, req.params.id));
}
