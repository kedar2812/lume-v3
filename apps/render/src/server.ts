import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LIMITS, type Limits } from "./limits";
import {
  PDF_TYPES,
  PHOTO_TYPES,
  THUMB_TYPES,
  looksLike,
  pdfOf,
  photoOf,
  thumbOf,
  type Thumb,
} from "./render";
import { RenderError } from "./run";

/*
 * LUME's render service (plan 2026-10-20-media-tab, Task 1): bytes in, a thumbnail or a PDF out. It knows nothing of
 * leads, files' names or the database, reaches nothing (its network is the API's alone), and does one job at a time.
 *
 *   POST /v1/thumb  a photo, video or PDF  → image/webp, with x-pages, x-duration-ms, x-width, x-height when known
 *   POST /v1/pdf    an Office or text file → application/pdf
 *   POST /v1/photo  a photo                → image/jpeg that fits WhatsApp's 5 MB
 *   GET  /healthz                          → 200
 */

export type Engine = {
  thumb(bytes: Buffer, mime: string, l: Limits): Promise<Thumb>;
  pdf(bytes: Buffer, mime: string, l: Limits): Promise<Buffer>;
  photo(bytes: Buffer, mime: string, l: Limits): Promise<Buffer>;
};
const REAL: Engine = { thumb: thumbOf, pdf: pdfOf, photo: photoOf };

/**
 * The body, or 413 when it's bigger than the limit. Past the limit nothing more is kept, but the rest is read to its
 * end, so the API hears 413 rather than a connection cut off mid-upload.
 */
function bodyOf(req: IncomingMessage, most: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = Number(req.headers["content-length"]) > most ? Infinity : 0;
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size <= most) parts.push(b);
    });
    req.on("end", () =>
      size > most ? reject(new RenderError("Too big", 413)) : resolve(Buffer.concat(parts)),
    );
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "application/json" : "application/octet-stream",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

export function renderServer(
  engine: Engine = REAL,
  limits: Limits = LIMITS,
  log: (line: string) => void = console.log,
): Server {
  // One job at a time: LibreOffice and ffmpeg each want the whole of the container's memory.
  let chain: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    if (waiting >= limits.queue) return Promise.reject(new RenderError("Busy, try again later", 503));
    waiting++;
    const mine = chain.then(job).finally(() => waiting--);
    chain = mine.catch(() => undefined);
    return mine;
  };

  return createServer(async (req, res) => {
    const started = Date.now();
    const route = req.url?.split("?")[0] ?? "";
    const mime = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    let status = 500;
    try {
      if (req.method === "GET" && route === "/healthz") return send(res, (status = 200), '{"ok":true}');
      const isThumb = req.method === "POST" && route === "/v1/thumb";
      const isPdf = req.method === "POST" && route === "/v1/pdf";
      const isPhoto = req.method === "POST" && route === "/v1/photo";
      if (!isThumb && !isPdf && !isPhoto) throw new RenderError("Not here", 404);
      if (!(isThumb ? THUMB_TYPES : isPdf ? PDF_TYPES : PHOTO_TYPES)[mime])
        throw new RenderError(`Not a type for ${route}`, 415);
      const bytes = await bodyOf(req, limits.bytes);
      if (!looksLike(bytes, mime)) throw new RenderError(`These bytes aren't ${mime}`, 415);
      if (isPhoto) {
        const photo = await inTurn(() => engine.photo(bytes, mime, limits));
        return send(res, (status = 200), photo, { "content-type": "image/jpeg" });
      }
      if (isPdf) {
        const pdf = await inTurn(() => engine.pdf(bytes, mime, limits));
        return send(res, (status = 200), pdf, { "content-type": "application/pdf" });
      }
      const t = await inTurn(() => engine.thumb(bytes, mime, limits));
      const known: Record<string, string> = {};
      if (t.pages) known["x-pages"] = String(t.pages);
      if (t.durationMs) known["x-duration-ms"] = String(t.durationMs);
      if (t.width) known["x-width"] = String(t.width);
      if (t.height) known["x-height"] = String(t.height);
      return send(res, (status = 200), t.webp, { "content-type": "image/webp", ...known });
    } catch (e) {
      const err = e instanceof RenderError ? e : new RenderError("Something went wrong", 500);
      status = err.status;
      if (!(e instanceof RenderError)) console.error(e);
      req.resume(); // a body refused unread is drained, never left on the socket
      send(res, status, JSON.stringify({ error: err.message }));
    } finally {
      if (route !== "/healthz") log(JSON.stringify({ route, mime, status, ms: Date.now() - started }));
    }
  });
}
