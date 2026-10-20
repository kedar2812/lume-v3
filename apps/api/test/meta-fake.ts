import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Meta Graph API calls LUME makes for WhatsApp (plan W1), over real HTTP: the Embedded Signup code
 * exchange, subscribing a WhatsApp account with its own callback, a number's details, the coexistence syncs, and
 * media. It answers as Meta's docs say Meta does (to verify against the test number), and it can deliver a webhook
 * signed the way Meta signs them. Tests drive it through its methods; e2e through /__fake/*.
 */
export type MetaFake = {
  url: string;
  version: string;
  appId: string;
  appSecret: string;
  configId: string;
  verifyToken: string;
  calls: { method: string; path: string; body: unknown; auth: string | null }[];
  /** Embedded Signup codes the exchange accepts, and the business token each one gives. */
  codes: Map<string, string>;
  numbers: Map<string, { display: string; name: string }>;
  media: Map<string, { mime: string; bytes: Buffer }>;
  /** A media item's link, when it isn't the fake's own download (a host that isn't Meta's, a redirect). */
  mediaUrls: Map<string, string>;
  /** Tokens Meta no longer accepts (190). */
  revoked: Set<string>;
  failHistorySync: boolean;
  /** Replies from LUME (W3a): files uploaded for a number, and messages sent, in order. */
  uploads: { id: string; numberId: string; size: number }[];
  sent: { numberId: string; body: Record<string, unknown> }[];
  /** Media ids Meta no longer has (expired): a send with one fails as Meta's does. */
  expired: Set<string>;
  /** The next sends answer with these Meta error codes, one each, in order. */
  failNext: number[];
  /** Templates (W3b-2), by name: what WhatsApp holds for each and how many variables its body has. */
  templates: Map<string, FakeTemplate>;
  /** How many templates a page of the list holds, and a `paging.next` to answer with instead of the fake's own. */
  templatePageSize: number;
  templateNextUrl: string | null;
  /** Header files uploaded for templates (resumable upload): each handle, the bytes' size and type. */
  headerUploads: Map<string, { size: number; type: string }>;
  /**
   * WhatsApp's decision on a template (or its new category): the template changes, and the webhook Meta would send
   * for its account comes back, for a test to deliver.
   */
  templateUpdate(
    name: string,
    o: { status: string; reason?: string; category?: "MARKETING" | "UTILITY" },
  ): Record<string, unknown>;
  /** POST a webhook body to `to`, signed with the app secret as Meta signs it (`X-Hub-Signature-256`). */
  deliver(to: string, body: unknown): Promise<Response>;
  close(): Promise<void>;
};

const oauthError = (code: number, message: string) => ({ error: { message, type: "OAuthException", code } });

type SentTemplate = {
  name: string;
  components?: { type: string; parameters?: { type: string; text?: string }[] }[];
};
const templateSummary = (t: unknown) => {
  const x = t as SentTemplate;
  const part = (type: string) => x.components?.find((c) => c.type === type)?.parameters ?? [];
  return {
    name: x.name,
    values: part("body").map((p) => p.text),
    header: part("header")[0]?.type ?? null,
  };
};

export type FakeTemplate = {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  reason: string | null;
  /** How many numbered variables its body has. */
  params: number;
};

export async function startMetaFake(o: { port?: number; version?: string } = {}): Promise<MetaFake> {
  const version = o.version ?? "v23.0";
  const state = {
    appId: "1234567890",
    appSecret: "meta-app-secret-for-tests",
    configId: "987654321",
    verifyToken: "verify-token-for-tests",
    calls: [] as MetaFake["calls"],
    codes: new Map<string, string>([["good-code", "EAAG-business-token"]]),
    numbers: new Map([["106540352242922", { display: "+91 90000 00001", name: "Harbour Studio" }]]),
    media: new Map<string, { mime: string; bytes: Buffer }>(),
    mediaUrls: new Map<string, string>(),
    revoked: new Set<string>(),
    failHistorySync: false,
    uploads: [] as { id: string; numberId: string; size: number }[],
    sent: [] as { numberId: string; body: Record<string, unknown> }[],
    expired: new Set<string>(),
    failNext: [] as number[],
    templates: new Map<string, FakeTemplate>(),
    templatePageSize: 100,
    templateNextUrl: null as string | null,
    headerUploads: new Map<string, { size: number; type: string }>(),
  };
  const uploadSessions = new Map<string, string>();
  /** WhatsApp's webhook for a template's account, as Meta sends it. */
  const templateUpdate = (
    name: string,
    o: { status: string; reason?: string; category?: "MARKETING" | "UTILITY" },
  ) => {
    const t = state.templates.get(name);
    if (!t) throw new Error(`no template ${name}`);
    const previous = t.category;
    t.status = o.status;
    t.reason = o.reason ?? null;
    const ids = {
      message_template_id: Number(t.id),
      message_template_name: t.name,
      message_template_language: t.language,
    };
    const changes: Record<string, unknown>[] = [
      {
        field: "message_template_status_update",
        value: { event: o.status, ...ids, reason: o.reason ?? "NONE" },
      },
    ];
    if (o.category) {
      t.category = o.category;
      changes.push({
        field: "template_category_update",
        value: { ...ids, previous_category: previous, new_category: o.category },
      });
    }
    return {
      object: "whatsapp_business_account",
      entry: [{ id: t.wabaId, time: Math.floor(Date.now() / 1000), changes }],
    };
  };
  let base = "";
  const deliver = (to: string, body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = `sha256=${createHmac("sha256", state.appSecret).update(raw).digest("hex")}`;
    return fetch(to, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      body: raw,
    });
  };
  const tokens = () => new Set(state.codes.values());
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      const bytes = Buffer.concat(chunks);
      const json = (req.headers["content-type"] ?? "").includes("json");
      const raw = json ? bytes.toString("utf8") : "";
      const body = raw ? (JSON.parse(raw) as unknown) : null;
      // Meta takes a token as Bearer, and as OAuth for the resumable upload (W3b-2): `auth` keeps the latter's word.
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
      const token = auth?.replace(/^OAuth /, "") ?? null;
      state.calls.push({ method: req.method ?? "GET", path: u.pathname, body, auth });

      // e2e drives the fake over HTTP.
      if (u.pathname === "/__fake/media" && req.method === "POST") {
        const b = body as { id: string; mime: string; base64: string };
        state.media.set(b.id, { mime: b.mime, bytes: Buffer.from(b.base64, "base64") });
        return send(res, 200, { ok: true });
      }
      // Replies from LUME (W3a): what was sent, each with the id Meta gave it, for e2e to send its statuses.
      if (u.pathname === "/__fake/sent" && req.method === "GET")
        return send(res, 200, {
          sent: state.sent.map((m, i) => ({
            to: m.body.to,
            type: m.body.type,
            wamid: `wamid.OUT${i + 1}`,
            // A document's name as WhatsApp shows it (W3b-1: a library file keeps its name on the way out).
            ...(m.body.document ? { filename: (m.body.document as { filename?: string }).filename } : {}),
            // A template (W3b-2): its name, its values in order, and the kind of file at the top.
            ...(m.body.template ? { template: templateSummary(m.body.template) } : {}),
          })),
        });
      // WhatsApp decides on a template (W3b-2): e2e delivers the webhook to the relay, as Meta would.
      if (u.pathname === "/__fake/template" && req.method === "POST") {
        const b = body as {
          /** Left out: the template made last (e2e can't see the name LUME gave it). */
          name?: string;
          status: string;
          reason?: string;
          category?: "MARKETING" | "UTILITY";
          to?: string;
        };
        const hook = templateUpdate(b.name ?? [...state.templates.keys()].at(-1)!, b);
        if (!b.to) return send(res, 200, hook);
        void deliver(b.to, hook).then(
          (r) => send(res, 200, { delivered: r.status }),
          () => send(res, 502, { delivered: null }),
        );
        return;
      }
      if (u.pathname === "/__fake/revoke" && req.method === "POST") {
        state.revoked.add((body as { token: string }).token);
        return send(res, 200, { ok: true });
      }
      // A redirect, as a CDN might answer: wherever `to` says.
      if (u.pathname === "/redirect") {
        res.writeHead(302, { location: u.searchParams.get("to") ?? "/" });
        return res.end();
      }
      if (u.pathname.startsWith("/download/")) {
        if (!auth || !tokens().has(auth) || state.revoked.has(auth))
          return send(res, 401, oauthError(190, "Invalid token"));
        const m = state.media.get(u.pathname.slice("/download/".length));
        if (!m) return send(res, 404, oauthError(100, "Not found"));
        res.writeHead(200, { "content-type": m.mime, "content-length": String(m.bytes.length) });
        return res.end(m.bytes);
      }

      const prefix = `/${version}/`;
      if (!u.pathname.startsWith(prefix)) return send(res, 404, oauthError(100, "Unknown path"));
      const parts = u.pathname.slice(prefix.length).split("/");

      if (parts[0] === "oauth" && parts[1] === "access_token") {
        const token = state.codes.get(u.searchParams.get("code") ?? "");
        if (
          u.searchParams.get("client_id") !== state.appId ||
          u.searchParams.get("client_secret") !== state.appSecret
        )
          return send(res, 400, oauthError(1, "Invalid client"));
        if (!token) return send(res, 400, oauthError(100, "Invalid verification code format."));
        return send(res, 200, { access_token: token, token_type: "bearer" });
      }
      // Everything else needs a business token Meta still accepts.
      if (!token || !tokens().has(token) || state.revoked.has(token))
        return send(res, 401, oauthError(190, "Error validating access token"));

      const [id, edge] = parts;
      // A template's header file (W3b-2), Meta's resumable upload: a session for the app, then the bytes.
      if (edge === "uploads" && req.method === "POST") {
        if (id !== state.appId) return send(res, 400, oauthError(100, "Invalid app id"));
        const session = `upload:${uploadSessions.size + 1}`;
        uploadSessions.set(session, u.searchParams.get("file_type") ?? "application/octet-stream");
        return send(res, 200, { id: session });
      }
      if (!edge && id && uploadSessions.has(id) && req.method === "POST") {
        if (req.headers.file_offset !== "0")
          return send(res, 400, oauthError(100, "file_offset is required"));
        const h = `4::${Buffer.from(id).toString("base64")}`;
        state.headerUploads.set(h, { size: bytes.length, type: uploadSessions.get(id)! });
        return send(res, 200, { h });
      }
      // Templates (W3b-2): created for review, listed a page at a time.
      if (edge === "message_templates" && req.method === "POST") {
        const t = body as {
          name: string;
          language: string;
          category: string;
          components?: Record<string, unknown>[];
        };
        const comps = t.components ?? [];
        const bodyComp = comps.find((c) => c.type === "BODY") as
          { text?: string; example?: { body_text?: string[][] } } | undefined;
        const params = new Set((bodyComp?.text ?? "").match(/\{\{\d+\}\}/g) ?? []).size;
        if (params && (bodyComp?.example?.body_text?.[0]?.length ?? 0) !== params)
          return send(
            res,
            400,
            oauthError(100, "Param example_body_text requires a value for each variable"),
          );
        const header = comps.find((c) => c.type === "HEADER") as
          { example?: { header_handle?: string[] } } | undefined;
        if (header && !header.example?.header_handle?.[0])
          return send(res, 400, oauthError(100, "Param example_header_handle is required"));
        if (state.templates.has(t.name))
          return send(res, 400, oauthError(100, "Content in this language already exists"));
        const made: FakeTemplate = {
          id: String(800_000_000 + state.templates.size + 1),
          wabaId: id!,
          name: t.name,
          language: t.language,
          category: t.category,
          status: "PENDING",
          reason: null,
          params,
        };
        state.templates.set(t.name, made);
        return send(res, 200, { id: made.id, status: made.status, category: made.category });
      }
      if (edge === "message_templates" && req.method === "GET") {
        const all = [...state.templates.values()].filter((t) => t.wabaId === id);
        const from = Number(u.searchParams.get("after") ?? 0);
        const page = all.slice(from, from + state.templatePageSize);
        const more = from + page.length < all.length;
        return send(res, 200, {
          data: page.map((t) => ({
            id: t.id,
            name: t.name,
            language: t.language,
            status: t.status,
            category: t.category,
            rejected_reason: t.reason ?? "NONE",
          })),
          paging: more
            ? {
                next:
                  state.templateNextUrl ??
                  `${base}/${version}/${id}/message_templates?after=${from + page.length}`,
              }
            : {},
        });
      }
      // Replies from LUME (W3a): a file uploaded for a number, then a message that names it.
      if (edge === "media" && req.method === "POST") {
        const up = { id: `UP${state.uploads.length + 1}`, numberId: id!, size: bytes.length };
        state.uploads.push(up);
        return send(res, 200, { id: up.id });
      }
      if (edge === "messages" && req.method === "POST") {
        const code = state.failNext.shift();
        if (code) return send(res, 400, oauthError(code, "Message failed"));
        const m = body as Record<string, unknown>;
        if (m.type === "template") {
          const tm = m.template as { name: string; components?: { type: string; parameters?: unknown[] }[] };
          const t = state.templates.get(tm.name);
          if (!t || t.status !== "APPROVED")
            return send(res, 400, oauthError(132001, "Template name does not exist in the translation"));
          const given = tm.components?.find((c) => c.type === "body")?.parameters?.length ?? 0;
          if (given !== t.params)
            return send(
              res,
              400,
              oauthError(132000, "Number of parameters does not match the expected number"),
            );
        }
        const file = (m[String(m.type)] ?? {}) as { id?: string };
        if (file.id && (state.expired.has(file.id) || !state.uploads.some((u) => u.id === file.id)))
          return send(res, 400, oauthError(131053, "Media upload error"));
        state.sent.push({ numberId: id!, body: m });
        return send(res, 200, {
          messaging_product: "whatsapp",
          contacts: [{ input: m.to, wa_id: m.to }],
          messages: [{ id: `wamid.OUT${state.sent.length}` }],
        });
      }
      if (edge === "subscribed_apps") return send(res, 200, { success: true });
      if (edge === "smb_app_data") {
        const kind = (body as { sync_type?: string } | null)?.sync_type;
        if (kind === "history" && state.failHistorySync)
          return send(res, 400, oauthError(131000, "History sync isn't available for this number"));
        return send(res, 200, { success: true, request_id: randomBytes(6).toString("hex") });
      }
      if (!edge && id && state.numbers.has(id)) {
        const n = state.numbers.get(id)!;
        return send(res, 200, { id, display_phone_number: n.display, verified_name: n.name });
      }
      if (!edge && id && state.media.has(id)) {
        const m = state.media.get(id)!;
        return send(res, 200, {
          id,
          url: state.mediaUrls.get(id) ?? `${base}/download/${id}`,
          mime_type: m.mime,
          file_size: m.bytes.length,
          messaging_product: "whatsapp",
        });
      }
      return send(res, 404, oauthError(100, "Unsupported get request"));
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return Object.assign(state, {
    url: base,
    version,
    deliver,
    templateUpdate,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
