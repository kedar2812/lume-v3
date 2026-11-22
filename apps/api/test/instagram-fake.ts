import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Instagram's side of LUME (Instagram API with Instagram Login; plan 1A), over real HTTP: the OAuth code
 * exchange, the long-lived token and its refresh, the account, webhook subscriptions, the Send API (DMs, private replies),
 * public comment replies, the User Profile API, the Conversations API and attachment downloads. It answers as Meta's
 * pages (read 2026-11-22) say Meta does, to verify against the test account, and it can deliver a webhook signed the
 * way Meta signs them. Tests drive it through its fields; e2e through /__fake/*.
 */
export type IgFakeAccount = { userId: string; username: string; name: string; accountType: string };
export type IgFakeSent = {
  accountId: string;
  body: Record<string, unknown>;
  mid: string;
  at: number;
};
export type IgFakeConversation = {
  id: string;
  igsid: string;
  messages: { id: string; from: string; text: string; created: string }[];
};
export type InstagramFake = {
  url: string;
  /** The browser's authorize page (not served: tests post the code to the relay as Instagram's redirect would). */
  oauthUrl: string;
  tokenUrl: string;
  graphUrl: string;
  version: string;
  appId: string;
  appSecret: string;
  verifyToken: string;
  calls: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    auth: string | null;
  }[];
  /** OAuth codes the exchange accepts: the account they're for, and the permissions the person granted. */
  codes: Map<string, { account: IgFakeAccount; permissions: string[] }>;
  /** Long-lived tokens and whose they are. */
  tokens: Map<string, IgFakeAccount>;
  /** Tokens Meta no longer takes (190). */
  revoked: Set<string>;
  /** Accounts subscribed to webhooks, with their fields. */
  subscriptions: Map<string, string[]>;
  /** Calls to these paths answer 500 (a step of the connect failing). Match by suffix. */
  failPaths: Set<string>;
  sent: IgFakeSent[];
  publicReplies: { commentId: string; message: string }[];
  /** The next sends answer with these Meta error codes (or "lose": taken, then the answer lost), one each. */
  failNext: (number | "lose" | { code: number; subcode: number })[];
  /** Profiles by IGSID; one missing answers "User consent is required". */
  profiles: Map<string, { name: string; username: string; is_user_follow_business?: boolean }>;
  conversations: Map<string, IgFakeConversation[]>;
  /** Files served at `<url>/cdn/<name>`, as Instagram's CDN would. */
  files: Map<string, { type: string; bytes: Buffer }>;
  /** A Meta webhook body, signed with the app secret, posted to `to`. */
  deliver(to: string, body: unknown, o?: { secret?: string }): Promise<Response>;
  /** A data deletion / deauthorize signed_request, as Meta posts it. */
  signedRequest(userId: string, o?: { secret?: string }): string;
  close(): Promise<void>;
};

const oauthError = (code: number, message: string, subcode?: number) => ({
  error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}) },
});

export async function startInstagramFake(o: { version?: string } = {}): Promise<InstagramFake> {
  const version = o.version ?? "v27.0";
  const appSecret = "instagram-app-secret-for-tests";
  const state = {
    appId: "5550000000000001",
    appSecret,
    verifyToken: "ig-verify-token-for-tests",
    calls: [] as InstagramFake["calls"],
    codes: new Map<string, { account: IgFakeAccount; permissions: string[] }>(),
    tokens: new Map<string, IgFakeAccount>(),
    revoked: new Set<string>(),
    subscriptions: new Map<string, string[]>(),
    failPaths: new Set<string>(),
    sent: [] as IgFakeSent[],
    publicReplies: [] as { commentId: string; message: string }[],
    failNext: [] as InstagramFake["failNext"],
    profiles: new Map<string, { name: string; username: string; is_user_follow_business?: boolean }>(),
    conversations: new Map<string, IgFakeConversation[]>(),
    files: new Map<string, { type: string; bytes: Buffer }>(),
  };
  const shortTokens = new Map<string, IgFakeAccount>();
  let n = 0;
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      const query = Object.fromEntries(u.searchParams);
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = req.headers["content-type"] ?? "";
      const body: unknown = !raw
        ? null
        : type.includes("json")
          ? (JSON.parse(raw) as unknown)
          : Object.fromEntries(new URLSearchParams(raw));
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
      const token = auth ?? query.access_token ?? null;
      state.calls.push({ method: req.method ?? "GET", path: u.pathname, query, body, auth });
      if ([...state.failPaths].some((p) => u.pathname.endsWith(p)))
        return send(res, 500, { error: { code: 2 } });

      // e2e drives the fake over HTTP.
      if (u.pathname === "/__fake/sent" && req.method === "GET") return send(res, 200, { sent: state.sent });
      if (u.pathname === "/__fake/code" && req.method === "POST") {
        const b = body as { code: string; account: IgFakeAccount; permissions?: string[] };
        state.codes.set(b.code, { account: b.account, permissions: b.permissions ?? ALL_PERMISSIONS });
        return send(res, 200, { ok: true });
      }

      // Short-lived token from the code (form post with the app secret).
      if (u.pathname === "/oauth/access_token" && req.method === "POST") {
        const f = (body ?? {}) as Record<string, string>;
        const c = state.codes.get(f.code ?? "");
        if (f.client_secret !== state.appSecret || f.client_id !== state.appId)
          return send(res, 400, { error_type: "OAuthException", code: 400, error_message: "Invalid client" });
        if (!c || f.grant_type !== "authorization_code")
          return send(res, 400, {
            error_type: "OAuthException",
            code: 400,
            error_message: "This authorization code has been used",
          });
        state.codes.delete(f.code!);
        const short = `IGQshort${++n}`;
        shortTokens.set(short, c.account);
        return send(res, 200, {
          data: [{ access_token: short, user_id: c.account.userId, permissions: c.permissions.join(",") }],
        });
      }
      // The long-lived token (60 days), with the app secret.
      if (u.pathname === "/access_token" && req.method === "GET") {
        const acct = shortTokens.get(query.access_token ?? "");
        if (query.client_secret !== state.appSecret || query.grant_type !== "ig_exchange_token" || !acct)
          return send(res, 400, oauthError(190, "Invalid OAuth access token"));
        const long = `IGQlong${++n}`;
        state.tokens.set(long, acct);
        return send(res, 200, { access_token: long, token_type: "bearer", expires_in: 5184000 });
      }
      // A refresh: no app secret; a token Meta refuses answers 190.
      if (u.pathname === "/refresh_access_token" && req.method === "GET") {
        const t = query.access_token ?? "";
        const acct = state.tokens.get(t);
        if (!acct || state.revoked.has(t) || query.grant_type !== "ig_refresh_token")
          return send(res, 400, oauthError(190, "Error validating access token"));
        const next = `IGQlong${++n}`;
        state.tokens.set(next, acct);
        return send(res, 200, { access_token: next, token_type: "bearer", expires_in: 5184000 });
      }
      if (u.pathname.startsWith("/cdn/")) {
        const f = state.files.get(u.pathname.slice(5));
        if (!f) return send(res, 404, {});
        res.writeHead(200, { "content-type": f.type, "content-length": String(f.bytes.length) });
        return res.end(f.bytes);
      }

      const m = new RegExp(`^/${version.replace(".", "\\.")}/([^/]+)(?:/([^/]+))?$`).exec(u.pathname);
      if (!m) return send(res, 404, { error: { message: "Unknown path", code: 803 } });
      const [, node, edge] = m;
      const acct = token ? state.tokens.get(token) : undefined;
      if (!acct || state.revoked.has(token!))
        return send(res, 400, oauthError(190, "Error validating access token"));

      if (node === "me" && !edge && req.method === "GET")
        return send(res, 200, {
          id: `app-scoped-${acct.userId}`,
          user_id: acct.userId,
          username: acct.username,
          name: acct.name,
          account_type: acct.accountType,
        });
      if (edge === "subscribed_apps" && (node === acct.userId || node === "me")) {
        if (req.method === "POST") {
          state.subscriptions.set(acct.userId, (query.subscribed_fields ?? "").split(",").filter(Boolean));
          return send(res, 200, { success: true });
        }
        if (req.method === "DELETE") {
          state.subscriptions.delete(acct.userId);
          return send(res, 200, { success: true });
        }
      }
      if (edge === "messages" && req.method === "POST" && (node === acct.userId || node === "me")) {
        const next = state.failNext.shift();
        const b = (body ?? {}) as Record<string, unknown>;
        if (next === "lose") {
          state.sent.push({ accountId: acct.userId, body: b, mid: `aWdfOUT${++n}`, at: Date.now() });
          res.writeHead(502);
          return res.end();
        }
        if (typeof next === "number") return send(res, 400, oauthError(next, "Meta refused"));
        if (next) return send(res, 400, oauthError(next.code, "Meta refused", next.subcode));
        const mid = `aWdfOUT${++n}`;
        state.sent.push({ accountId: acct.userId, body: b, mid, at: Date.now() });
        const r = b.recipient as { id?: string } | undefined;
        return send(res, 200, { recipient_id: r?.id ?? "6512000000000001", message_id: mid });
      }
      if (edge === "replies" && req.method === "POST") {
        const msg = query.message ?? ((body ?? {}) as { message?: string }).message ?? "";
        state.publicReplies.push({ commentId: node!, message: msg });
        return send(res, 200, { id: `reply-${++n}` });
      }
      if (edge === "conversations" && req.method === "GET") {
        const list = state.conversations.get(acct.userId) ?? [];
        return send(res, 200, {
          data: list.map((c) => ({ id: c.id, updated_time: c.messages.at(-1)?.created })),
        });
      }
      if (!edge && req.method === "GET") {
        const conv = [...state.conversations.values()].flat().find((c) => c.id === node);
        if (conv)
          return send(res, 200, {
            id: conv.id,
            messages: {
              data: conv.messages.slice(-20).map((x) => ({
                id: x.id,
                created_time: x.created,
                from: { id: x.from },
                message: x.text,
              })),
            },
          });
        const p = state.profiles.get(node!);
        if (!p) return send(res, 400, oauthError(230, "User consent is required to access user profile"));
        return send(res, 200, { ...p, id: node });
      }
      return send(res, 404, { error: { message: "Unknown path", code: 803 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const deliver = (to: string, body: unknown, d: { secret?: string } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = `sha256=${createHmac("sha256", d.secret ?? appSecret)
      .update(raw)
      .digest("hex")}`;
    return fetch(to, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      body: raw,
    });
  };
  const signedRequest = (userId: string, d: { secret?: string } = {}) => {
    const payload = Buffer.from(
      JSON.stringify({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    const sig = createHmac("sha256", d.secret ?? appSecret)
      .update(payload)
      .digest("base64url");
    return `${sig}.${payload}`;
  };
  return Object.assign(state, {
    url,
    oauthUrl: `${url}/oauth/authorize`,
    tokenUrl: `${url}/oauth/access_token`,
    graphUrl: url,
    version,
    deliver,
    signedRequest,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

export const ALL_PERMISSIONS = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];

/** A professional account for tests (fictional). */
export const fakeAccount = (o: Partial<IgFakeAccount> = {}): IgFakeAccount => ({
  userId: "17841400000000001",
  username: "harbour.studio",
  name: "Harbour Studio",
  accountType: "BUSINESS",
  ...o,
});

export const randomCode = () => randomBytes(8).toString("hex");
