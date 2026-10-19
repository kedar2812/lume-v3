import type { AppDeps } from "../../app";

/** The most a photo, voice note or file may be (spec 2026-10-18 §4.1). */
export const MEDIA_MAX = 25 * 1024 * 1024;

/** Why Meta said no: the token (revoked, the number disconnected in the app), too large, or for now only. */
export class MetaError extends Error {
  constructor(
    readonly kind: "token" | "too_large" | "not_found" | "transient" | "untrusted",
    message: string,
    /** Meta's own error code, when it gave one (a reply's refusal is said from it: core's `refusalOf`). */
    readonly code: number | null = null,
    /** Meta's own words for a person, when it gave them (a template it won't take says why). */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "MetaError";
  }
}

/** Where Meta serves media from. The token only ever goes to these, or to the Graph API itself. */
const MEDIA_HOSTS = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/;

/**
 * Whether a media link may be fetched with a number's token: https on Meta's own media hosts, or the configured Graph
 * API's origin (the fake, in tests). Anything else would hand the token to someone else's server.
 */
export function trustedMediaUrl(url: string, graphUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.origin === new URL(graphUrl).origin) return true;
  return u.protocol === "https:" && MEDIA_HOSTS.test(u.hostname);
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
      throw new MetaError("token", "WhatsApp stopped letting LUME in.", 190);
    if (r.status === 404) throw new MetaError("not_found", "WhatsApp no longer has this.");
    // A redirect asked to be handled by the caller (media links): checked there.
    if (init.redirect === "manual" && r.status >= 300 && r.status < 400) return r;
    if (!r.ok) {
      // Meta says an expired or revoked token with code 190, sometimes as a 400.
      const body = (await r.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string; error_user_msg?: string };
      };
      const code = typeof body.error?.code === "number" ? body.error.code : null;
      if (code === 190) throw new MetaError("token", "WhatsApp stopped letting LUME in.", 190);
      const said = body.error?.error_user_msg ?? body.error?.message ?? null;
      throw new MetaError(
        "transient",
        "WhatsApp didn't answer properly just now.",
        code,
        said?.slice(0, 300) ?? null,
      );
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
      if (!trustedMediaUrl(url, meta.graphUrl))
        throw new MetaError("untrusted", "WhatsApp sent a link that isn't Meta's.");
      // Redirects are followed only on Meta's hosts: one elsewhere would carry the token.
      const r = await call(url, { redirect: "manual" }).then(async (first) => {
        const to = first.status >= 300 && first.status < 400 ? first.headers.get("location") : null;
        if (!to) return first;
        const next = new URL(to, url).toString();
        if (!trustedMediaUrl(next, meta.graphUrl))
          throw new MetaError("untrusted", "WhatsApp sent a link that isn't Meta's.");
        return call(next, { redirect: "error" });
      });
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
    /** A file for a reply from LUME (plan W3a), uploaded for this number: Meta's id for it, good for 30 days. */
    async uploadMedia(phoneNumberId: string, bytes: Buffer, mime: string, filename: string): Promise<string> {
      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("type", mime);
      form.set("file", new Blob([bytes], { type: mime }), filename);
      const r = await call(graph(`${encodeURIComponent(phoneNumberId)}/media`), {
        method: "POST",
        body: form,
      });
      const d = (await r.json()) as { id?: string };
      if (!d.id) throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
      return d.id;
    },
    /** One message from this number (plan W3a): Meta's id for it (the `wamid` its statuses name). */
    async sendMessage(phoneNumberId: string, body: Record<string, unknown>): Promise<string> {
      const r = await call(graph(`${encodeURIComponent(phoneNumberId)}/messages`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as { messages?: { id?: string }[] };
      const wamid = d.messages?.[0]?.id;
      if (!wamid) throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
      return wamid;
    },
    /**
     * A template's header file (W3b-2), in Meta's resumable upload for the app: the handle a template names as its
     * sample. Meta's docs ask for the token as `OAuth` here.
     */
    async uploadForTemplate(appId: string, bytes: Buffer, mime: string, name: string): Promise<string> {
      const q = new URLSearchParams({ file_name: name, file_length: String(bytes.length), file_type: mime });
      const start = await call(graph(`${encodeURIComponent(appId)}/uploads?${q}`), { method: "POST" });
      const session = ((await start.json()) as { id?: string }).id;
      if (!session?.startsWith("upload:"))
        throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
      const up = await call(graph(session), {
        method: "POST",
        headers: { authorization: `OAuth ${token}`, file_offset: "0", "content-type": mime },
        body: new Uint8Array(bytes),
      });
      const h = ((await up.json()) as { h?: string }).h;
      if (!h) throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
      return h;
    },
    /** A template for WhatsApp to review (W3b-2): its id there, and where review stands. */
    async createTemplate(
      wabaId: string,
      payload: Record<string, unknown>,
    ): Promise<{ id: string; status: string; category: string }> {
      const r = await call(graph(`${encodeURIComponent(wabaId)}/message_templates`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as { id?: string; status?: string; category?: string };
      if (!d.id) throw new MetaError("transient", "WhatsApp didn't answer properly just now.");
      return { id: String(d.id), status: d.status ?? "PENDING", category: d.category ?? "" };
    },
    /**
     * These templates as WhatsApp holds them now (W3b-2's sweep, for a webhook that never came), a page at a time.
     * A next page anywhere but Meta is never asked with the token.
     */
    async templates(
      wabaId: string,
      names: string[],
    ): Promise<
      {
        id: string;
        name: string;
        language: string;
        status: string;
        category: string;
        reason: string | null;
      }[]
    > {
      const wanted = new Set(names);
      const out: Awaited<ReturnType<typeof this.templates>> = [];
      const fields = "id,name,language,status,category,rejected_reason";
      let next: string | null = graph(
        `${encodeURIComponent(wabaId)}/message_templates?fields=${fields}&limit=100`,
      );
      for (let pages = 0; next && pages < 50; pages++) {
        if (!trustedMediaUrl(next, meta.graphUrl))
          throw new MetaError("untrusted", "WhatsApp sent a link that isn't Meta's.");
        const r = await call(next);
        const d = (await r.json()) as {
          data?: {
            id: string;
            name: string;
            language: string;
            status: string;
            category: string;
            rejected_reason?: string;
          }[];
          paging?: { next?: string };
        };
        for (const t of d.data ?? [])
          if (wanted.has(t.name))
            out.push({
              id: String(t.id),
              name: t.name,
              language: t.language,
              status: t.status,
              category: t.category,
              reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
            });
        next = d.paging?.next ?? null;
      }
      return out;
    },
    /** Stop Meta delivering this WhatsApp account's messages to LUME. */
    async unsubscribe(wabaId: string): Promise<void> {
      await call(graph(`${encodeURIComponent(wabaId)}/subscribed_apps`), { method: "DELETE" });
    },
  };
}
