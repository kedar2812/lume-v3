import { stat } from "node:fs/promises";
import { schema } from "@lume/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { notFound } from "../../http/errors";
import { hashOfToken } from "./library";
import { streamFile } from "./media";
import { sendLimiter } from "./send";

const F = schema.messageFiles;

/** How many times one address may open file links in a minute (plan W3b-1 Task 3). */
export const LINK_OPENS_PER_MINUTE = 60;
/** How long a browser may keep a linked file: short, so switching a link off takes hold within minutes. */
const LINK_MAX_AGE = 300;
/** 32 random bytes, base64url: what `setFileLink` hands out. Anything else is never looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `GET|HEAD /f/:token` (plan W3b-1 Task 3): a library file for anyone who has its link, no sign-in. Malformed,
 * unknown, switched off, archived or gone from disk all answer one 404, so a link says nothing about why it stopped.
 * The file goes out exactly as a lead's media does (sandboxed, never sniffed; a document as a download, since a
 * browser won't show a PDF inside a sandbox).
 */
export async function fileLinkRoutes(app: FastifyInstance, d: AppDeps) {
  const limiter = sendLimiter({
    now: d.clock,
    perMinute: LINK_OPENS_PER_MINUTE,
    perHour: LINK_OPENS_PER_MINUTE * 60,
  });
  const gone = () => notFound();

  app.get<{ Params: { token: string } }>("/f/:token", { config: { public: true } }, async (req, reply) => {
    const gate = limiter.take(req.ip);
    if (!gate.ok)
      return reply
        .code(429)
        .header("retry-after", String(gate.retryAfterSec))
        .send({ error: { code: "TOO_MANY_OPENS", message: "Too many opens. Try again in a minute." } });
    const { token } = req.params;
    if (!TOKEN.test(token) || !d.files) throw gone();
    const [f] = await req.db
      .select({ id: F.id, sha256: F.sha256, name: F.name, mime: F.mime, kind: F.kind })
      .from(F)
      .where(and(eq(F.linkHash, hashOfToken(token)), eq(F.linkOn, true), isNull(F.archivedAt)));
    if (!f) throw gone();
    const path = d.files.store.path(f.sha256);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) throw gone();
    // A full open is a person reading it; a range is the same person's viewer, and a HEAD or a 304 reads nothing.
    const full =
      req.method === "GET" &&
      req.headers.range === undefined &&
      req.headers["if-none-match"] !== `"${f.sha256}"`;
    if (full)
      await req.db
        .update(F)
        .set({ opens: sql`${F.opens} + 1` })
        .where(eq(F.id, f.id));
    return streamFile(req, reply, { path, size: s.size }, { ...f, filename: f.name }, LINK_MAX_AGE);
  });
}
