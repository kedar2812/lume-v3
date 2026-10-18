import type { AppDeps } from "../../app";

/** The most a photo, voice note or file may be (spec 2026-10-18 §4.1). */
export const MEDIA_MAX = 25 * 1024 * 1024;

/** Why Meta said no: the token (revoked, the number disconnected in the app), too large, or for now only. */
export class MetaError extends Error {
  constructor(
    readonly kind: "token" | "too_large" | "not_found" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "MetaError";
  }
}

/**
 * The Graph API calls a client's LUME makes itself, with a number's own business token (spec 2026-10-18 §3–4): media,
 * and unsubscribing on disconnect. Connecting goes through the relay; this never sees Meta's app secret.
 */
export function metaClient(meta: NonNullable<AppDeps["meta"]>, token: string) {
  const graph = (path: string) => `${meta.graphUrl}/${meta.version}/${path}`;
  const call = async (url: string, init: RequestInit = {}) => {
    const r = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new MetaError("transient", "LUME couldn't reach WhatsApp just now.");
    });
    if (r.status === 401 || r.status === 403)
      throw new MetaError("token", "WhatsApp stopped letting LUME in.");
    if (r.status === 404) throw new MetaError("not_found", "WhatsApp no longer has this.");
    if (!r.ok) {
      // Meta says an expired or revoked token with code 190, sometimes as a 400.
      const body = (await r.json().catch(() => ({}))) as { error?: { code?: number } };
      if (body.error?.code === 190) throw new MetaError("token", "WhatsApp stopped letting LUME in.");
      throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
    }
    return r;
  };
  return {
    /** Where a media item can be fetched from (a short-lived link), and what it is. */
    async media(id: string): Promise<{ url: string; mime: string; size: number | null }> {
      const r = await call(graph(encodeURIComponent(id)));
      const d = (await r.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!d.url) throw new MetaError("not_found", "WhatsApp no longer has this.");
      return { url: d.url, mime: d.mime_type ?? "application/octet-stream", size: d.file_size ?? null };
    },
    /** The bytes, never more than 25 MB (checked as they arrive, whatever Meta said the size was). */
    async download(url: string): Promise<Buffer> {
      const r = await call(url);
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > MEDIA_MAX) throw new MetaError("too_large", "This file is over 25 MB.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of r.body as AsyncIterable<Uint8Array>) {
        size += c.length;
        if (size > MEDIA_MAX) throw new MetaError("too_large", "This file is over 25 MB.");
        chunks.push(Buffer.from(c));
      }
      return Buffer.concat(chunks);
    },
    /** Stop Meta delivering this WhatsApp account's messages to LUME. */
    async unsubscribe(wabaId: string): Promise<void> {
      await call(graph(`${encodeURIComponent(wabaId)}/subscribed_apps`), { method: "DELETE" });
    },
  };
}
