import { stat } from "node:fs/promises";
import { can } from "@lume/core";
import { schema } from "@lume/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { notFound } from "../../http/errors";
import { retryPreview } from "../whatsapp/library";
import { streamFile } from "../whatsapp/media";

const F = schema.messageFiles;
const P = schema.filePreviews;

/** How long a browser keeps a file it opened: an hour, as the file at an id never changes. */
const CONTENT_MAX_AGE = 3600;
/** A thumbnail's address has its content's hash in it: a year, and never asked for again. */
const THUMB_MAX_AGE = 31_536_000;

/**
 * Reading the business's files inside LUME (plan 2026-10-20-media-tab, Task 5): the file itself (byte ranges, so a
 * video seeks), its thumbnail, and a Word or PowerPoint file's PDF. Everyone who may use templates reads them; an
 * archived file only an admin. Anything else is one 404, never a 403 that says the file is there.
 */
async function fileFor(req: FastifyRequest, id: string) {
  const [row] = await req.db
    .select({ f: F, p: P })
    .from(F)
    .leftJoin(P, eq(P.sha256, F.sha256))
    .where(eq(F.id, id));
  if (!row || (row.f.archivedAt && !can(req.actor!, "templates.manage"))) throw notFound();
  return row;
}

async function sendStored(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  m: { sha256: string; mime: string; kind: string; filename: string | null },
  maxAge: number,
  immutable = false,
) {
  if (!d.files) throw notFound();
  const path = d.files.store.path(m.sha256);
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw notFound();
  return streamFile(req, reply, { path, size: s.size }, m, maxAge, immutable);
}

export async function mediaRoutes(app: FastifyInstance, d: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });

  r.get(
    "/api/v1/files/:id/content",
    { config: { permission: "templates.use" }, schema: { params } },
    async (req, reply) => {
      const { f } = await fileFor(req, req.params.id);
      return sendStored(req, reply, d, { ...f, filename: f.name }, CONTENT_MAX_AGE);
    },
  );
  r.get(
    "/api/v1/files/:id/thumb",
    { config: { permission: "templates.use" }, schema: { params } },
    async (req, reply) => {
      const { p } = await fileFor(req, req.params.id);
      if (p?.state !== "ready" || !p.thumbSha256) throw notFound();
      return sendStored(
        req,
        reply,
        d,
        { sha256: p.thumbSha256, mime: "image/webp", kind: "image", filename: null },
        THUMB_MAX_AGE,
        true,
      );
    },
  );
  r.get(
    "/api/v1/files/:id/pdf",
    { config: { permission: "templates.use" }, schema: { params } },
    async (req, reply) => {
      const { f, p } = await fileFor(req, req.params.id);
      if (!p?.pdfSha256) throw notFound();
      return sendStored(
        req,
        reply,
        d,
        { sha256: p.pdfSha256, mime: "application/pdf", kind: "document", filename: `${f.name}.pdf` },
        CONTENT_MAX_AGE,
      );
    },
  );
  r.post(
    "/api/v1/files/:id/preview",
    { config: { permission: "templates.manage" }, schema: { params } },
    async (req, reply) => reply.code(202).send(await retryPreview(req, d, req.params.id)),
  );
}
