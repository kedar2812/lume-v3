import { newId } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { notFound } from "../../http/errors";
import { sendStored } from "../media/routes";
import { checkFile, fileNameOf, keepBytes } from "../whatsapp/keep-bytes";
import { LIMITS } from "../whatsapp/sniff";
import type { FileView } from "./messages";

/**
 * Photos and files in Team Chat (plan 2026-11-24-team-chat-2a, Task 5). The bytes go into LUME's one file store (kept
 * once, counted once); the chat file is the sender's until a message uses it, then readable by whoever reads that
 * message, and by no one else.
 */
export async function uploadChatFile(
  req: FastifyRequest,
  d: AppDeps,
  bytes: Buffer,
  filename: string | null,
): Promise<{ file: FileView }> {
  const type = checkFile(bytes, filename);
  const name = (filename?.trim() || `File.${type.mime.split("/")[1] ?? "bin"}`).slice(0, 120);
  const sha256 = await keepBytes(req, d, bytes);
  const id = newId();
  await req.db.execute(sql`
    INSERT INTO chat_files (id, uploader_id, sha256, name, mime, kind, size)
    VALUES (${id}, ${req.actor!.userId}, ${sha256}, ${name}, ${type.mime}, ${type.kind}, ${bytes.length})`);
  return {
    file: { id, name, mime: type.mime, kind: type.kind, size: bytes.length, url: `/api/v1/chat/files/${id}` },
  };
}

export async function chatFileRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  await app.register(async (files) => {
    // Scoped: only this route takes a raw body, at most a document's size (+1, so one byte over is refused in words).
    files.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: LIMITS.document + 1 },
      (_req, body, done) => done(null, body),
    );
    files
      .withTypeProvider<ZodTypeProvider>()
      .post(
        "/api/v1/chat/files",
        { config: { permission: "chat.use", idempotent: false }, bodyLimit: LIMITS.document + 1 },
        async (req, reply) =>
          reply
            .code(201)
            .send(
              await uploadChatFile(
                req,
                d,
                Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
                fileNameOf(req),
              ),
            ),
      );
  });
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/api/v1/chat/files/:id",
      { config: { permission: "chat.use" }, schema: { params: z.object({ id: z.uuid() }) } },
      async (req, reply) => {
        // Row-level security decides: one's own file waiting to go, or a file on a message one may read.
        const f = (
          await req.db.execute<{
            sha256: string;
            mime: string;
            kind: string;
            name: string;
            message_id: string | null;
          }>(
            sql`SELECT f.sha256, f.mime, f.kind, f.name, f.message_id FROM chat_files f
              LEFT JOIN chat_messages m ON m.id = f.message_id
              WHERE f.id = ${req.params.id} AND (f.message_id IS NULL OR m.deleted_at IS NULL)`,
          )
        ).rows[0];
        if (!f) throw notFound("NOT_FOUND", "That file isn't there.");
        return sendStored(
          req,
          reply,
          d,
          { sha256: f.sha256, mime: f.mime, kind: f.kind, filename: f.name },
          3600,
        );
      },
    );
}
