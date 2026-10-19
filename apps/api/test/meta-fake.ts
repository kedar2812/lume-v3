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
  /** POST a webhook body to `to`, signed with the app secret as Meta signs it (`X-Hub-Signature-256`). */
  deliver(to: string, body: unknown): Promise<Response>;
  close(): Promise<void>;
};

const oauthError = (code: number, message: string) => ({ error: { message, type: "OAuthException", code } });

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
  };
  let base = "";
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
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as unknown) : null;
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
      state.calls.push({ method: req.method ?? "GET", path: u.pathname, body, auth });

      // e2e drives the fake over HTTP.
      if (u.pathname === "/__fake/media" && req.method === "POST") {
        const b = body as { id: string; mime: string; base64: string };
        state.media.set(b.id, { mime: b.mime, bytes: Buffer.from(b.base64, "base64") });
        return send(res, 200, { ok: true });
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
      if (!auth || !tokens().has(auth) || state.revoked.has(auth))
        return send(res, 401, oauthError(190, "Error validating access token"));

      const [id, edge] = parts;
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
    deliver: (to: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      const sig = `sha256=${createHmac("sha256", state.appSecret).update(raw).digest("hex")}`;
      return fetch(to, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        body: raw,
      });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
