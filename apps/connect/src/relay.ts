import { randomBytes } from "node:crypto";
import type http from "node:http";
import { instanceIdOf, seal, sign, verify, type Handoff } from "@lume/core";
import { pickerPage } from "./picker.html";

export type RelayConfig = {
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  pickerKey: string;
  appId: string;
  /** Signs the OAuth state, so only this relay can make one. */
  secret: string;
  instances: { url: string; token: string }[];
  googleAuthUrl?: string;
  googleTokenUrl?: string;
  now?: () => number;
};

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TEN_MIN = 10 * 60_000;
type State = { i: string; n: string; exp: number };

/**
 * The relay (2B spec §6): the one place Google calls back to, for every LUME instance. It holds the OAuth
 * client secret and the Picker key; it hands each instance its grant sealed with that instance's token,
 * and only ever redirects to the URL registered for it. It never sees lead data.
 */
export function createRelay(o: RelayConfig): http.RequestListener {
  const now = o.now ?? Date.now;
  const authUrl = o.googleAuthUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = o.googleTokenUrl ?? "https://oauth2.googleapis.com/token";
  const byId = new Map(o.instances.map((x) => [instanceIdOf(x.token), x]));
  const byToken = new Map(o.instances.map((x) => [x.token, x]));
  const redirectUri = `${o.publicUrl}/callback`;

  const packState = (s: State) => {
    const body = Buffer.from(JSON.stringify(s)).toString("base64url");
    return `${body}.${sign(o.secret, body)}`;
  };
  const readState = (raw: string | null): State | null => {
    if (!raw) return null;
    const [body, sig] = raw.split(".");
    if (!body || !sig || !verify(o.secret, body, sig)) return null;
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
    return s.exp > now() && byId.has(s.i) ? s : null;
  };
  const plain = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const body = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => {
        if (b.length < 20_000) b += c.toString("utf8");
      });
      req.on("end", () => resolve(b));
    });
  // Code tokens: one-time, short-lived, in memory — they only bridge the Picker page to /done.
  const pending = new Map<
    string,
    { refreshToken: string; accessToken: string; state: string; exp: number }
  >();

  async function exchange(params: Record<string, string>) {
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }

  return (req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", o.publicUrl);
      if (u.pathname === "/healthz") return json(res, 200, { status: "ok" });

      if (u.pathname === "/start" && req.method === "GET") {
        const id = u.searchParams.get("i") ?? "";
        const n = u.searchParams.get("n") ?? "";
        const inst = byId.get(id);
        if (!inst || !n || !verify(inst.token, n, u.searchParams.get("s") ?? ""))
          return plain(res, 400, "This link isn't valid. Go back to LUME and try again.");
        const to = new URL(authUrl);
        to.search = new URLSearchParams({
          client_id: o.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPE,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "false",
          state: packState({ i: id, n, exp: now() + TEN_MIN }),
        }).toString();
        res.writeHead(302, { location: to.toString(), "cache-control": "no-store" });
        return res.end();
      }

      if (u.pathname === "/callback" && req.method === "GET") {
        const raw = u.searchParams.get("state");
        const state = readState(raw);
        const code = u.searchParams.get("code");
        if (!state || !code)
          return plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        const t = await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        const refreshToken = t.data.refresh_token as string | undefined;
        const accessToken = t.data.access_token as string | undefined;
        if (t.status !== 200 || !refreshToken || !accessToken)
          return plain(res, 400, "Google didn't give LUME access. Go back to LUME and try again.");
        const codeToken = randomBytes(24).toString("base64url");
        pending.set(codeToken, { refreshToken, accessToken, state: raw!, exp: now() + TEN_MIN });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://apis.google.com https://*.googleapis.com; frame-src https://docs.google.com https://*.google.com; connect-src https://*.googleapis.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:",
        });
        return res.end(
          pickerPage({ accessToken, pickerKey: o.pickerKey, appId: o.appId, state: raw!, codeToken }),
        );
      }

      if (u.pathname === "/done" && req.method === "POST") {
        const f = new URLSearchParams(await body(req));
        const state = readState(f.get("state"));
        const p = pending.get(f.get("code_token") ?? "");
        pending.delete(f.get("code_token") ?? "");
        const fileId = f.get("file_id") ?? "";
        if (
          !state ||
          !p ||
          p.state !== f.get("state") ||
          p.exp < now() ||
          !/^[A-Za-z0-9_-]{10,}$/.test(fileId)
        )
          return plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        const inst = byId.get(state.i)!;
        const handoff: Handoff = {
          nonce: state.n,
          refreshToken: p.refreshToken,
          file: { id: fileId, name: (f.get("file_name") ?? "").slice(0, 200) },
          exp: now() + TEN_MIN,
        };
        const sealed = seal(inst.token, handoff);
        const back = new URL("/settings/integrations/connected", inst.url);
        back.search = new URLSearchParams({ p: sealed, s: sign(inst.token, sealed) }).toString();
        res.writeHead(302, { location: back.toString(), "cache-control": "no-store" });
        return res.end();
      }

      if (u.pathname === "/refresh" && req.method === "POST") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!byToken.has(token)) return json(res, 401, { error: "unknown_instance" });
        const { refreshToken } = JSON.parse((await body(req)) || "{}") as { refreshToken?: string };
        if (!refreshToken) return json(res, 400, { error: "bad_request" });
        const t = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
        if (t.status === 400 && t.data.error === "invalid_grant") return json(res, 400, { error: "revoked" });
        if (t.status !== 200) return json(res, 502, { error: "google_unavailable" });
        return json(res, 200, { accessToken: t.data.access_token, expiresIn: t.data.expires_in });
      }

      return plain(res, 404, "Not found");
    })().catch(() => plain(res, 500, "Something went wrong. Go back to LUME and try again."));
  };
}
