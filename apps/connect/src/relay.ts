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
  /** Google's API (Drive), to check a picked file is a spreadsheet. */
  googleApiUrl?: string;
  now?: () => number;
};

const SCOPE = "https://www.googleapis.com/auth/drive.file";
/** A calendar (Phase 5A): read-only — the events, and which calendars there are. Nothing else. */
const CALENDAR_SCOPE = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");
const TEN_MIN = 10 * 60_000;
/** `k`: "calendar" for a calendar's grant (Phase 5A); absent, a sheet's. */
type State = { i: string; n: string; exp: number; k?: "calendar" };

/**
 * The relay (2B spec §6): the one place Google calls back to, for every LUME instance. It holds the OAuth
 * client secret and the Picker key; it hands each instance its grant sealed with that instance's token,
 * and only ever redirects to the URL registered for it. It never sees lead data.
 */
export type Relay = http.RequestListener & {
  /** Code tokens held in memory right now (expired ones are swept at each sign-in). */
  pendingSize(): number;
};

/** Every page the relay serves: never framed, never sending the relay's address on. */
const HARDENED = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
// Text and double-quoted attributes only, so an apostrophe needs nothing.
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (v: string) => v.replace(/[&<>"]/g, (c) => ENTITIES[c]!);
/** A short page in words, with a way back to LUME when the instance is known. */
function wordsPage(title: string, text: string, back: string | null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LUME</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#eef0f3;color:#0a0c11}
main{background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 0 0 .5px rgba(12,18,32,.1),0 18px 50px rgba(12,18,32,.12);max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#5a606d;margin:0 0 16px}a{color:#2a5bff;font-weight:600}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${back ? `<a href="${escapeHtml(back)}">Back to LUME</a>` : ""}</main></body></html>`;
}

export function createRelay(o: RelayConfig): Relay {
  const now = o.now ?? Date.now;
  const authUrl = o.googleAuthUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = o.googleTokenUrl ?? "https://oauth2.googleapis.com/token";
  const apiUrl = o.googleApiUrl ?? "https://www.googleapis.com";
  const byId = new Map(o.instances.map((x) => [instanceIdOf(x.token), x]));
  const byToken = new Map(o.instances.map((x) => [x.token, x]));
  const redirectUri = `${o.publicUrl}/callback`;
  const backTo = (instanceId: string) => {
    const inst = byId.get(instanceId);
    return inst ? new URL("/settings/integrations", inst.url).toString() : null;
  };

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
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...HARDENED });
    res.end(text);
  };
  const page = (res: http.ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      ...HARDENED,
    });
    res.end(html);
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
  const sweep = () => {
    const t = now();
    for (const [k, v] of pending) if (v.exp < t) pending.delete(k);
  };
  /** Whether Drive says the picked file is a Google Sheet (asked with the grant just given); "unseen": 404. */
  async function isSpreadsheet(fileId: string, accessToken: string): Promise<boolean | null | "unseen"> {
    // supportsAllDrives: a sheet in a shared drive (common for a business) is found too.
    const r = await fetch(
      `${apiUrl}/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType&supportsAllDrives=true`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
    ).catch(() => null);
    if (!r) return null;
    if (r.status === 404) return "unseen";
    if (!r.ok) return null;
    const d = (await r.json().catch(() => ({}))) as { mimeType?: string };
    return d.mimeType === "application/vnd.google-apps.spreadsheet";
  }

  async function exchange(params: Record<string, string>) {
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }

  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      const u = new URL(req.url ?? "/", o.publicUrl);
      if (u.pathname === "/healthz") return json(res, 200, { status: "ok" });

      if (u.pathname === "/start" && req.method === "GET") {
        const id = u.searchParams.get("i") ?? "";
        const n = u.searchParams.get("n") ?? "";
        const inst = byId.get(id);
        const k = u.searchParams.get("k");
        // The kind is signed with the nonce, so a sheet's link can't be turned into a calendar's.
        if (
          !inst ||
          !n ||
          (k !== null && k !== "calendar") ||
          !verify(inst.token, k ? `${n}.${k}` : n, u.searchParams.get("s") ?? "")
        )
          return plain(res, 400, "This link isn't valid. Go back to LUME and try again.");
        const to = new URL(authUrl);
        to.search = new URLSearchParams({
          client_id: o.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: k === "calendar" ? CALENDAR_SCOPE : SCOPE,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "false",
          state: packState({ i: id, n, exp: now() + TEN_MIN, ...(k === "calendar" ? { k } : {}) }),
        }).toString();
        res.writeHead(302, { location: to.toString(), "cache-control": "no-store" });
        return res.end();
      }

      if (u.pathname === "/callback" && req.method === "GET") {
        sweep();
        const raw = u.searchParams.get("state");
        const state = readState(raw);
        const code = u.searchParams.get("code");
        // Consent turned down (or cancelled) at Google: said as it is, with a way back.
        if (state && u.searchParams.get("error"))
          return page(
            res,
            200,
            wordsPage(
              "LUME didn't get access",
              "You didn't give LUME access to a sheet. Go back to LUME and choose Continue with Google when you're ready.",
              backTo(state.i),
            ),
          );
        if (!state || !code)
          return plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        const t = await exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        const refreshToken = t.data.refresh_token as string | undefined;
        const accessToken = t.data.access_token as string | undefined;
        if (t.status !== 200 || !refreshToken || !accessToken)
          return plain(res, 400, "Google didn't give LUME access. Go back to LUME and try again.");
        // A calendar needs no Picker: its grant goes straight back to the instance's calendar page.
        if (state.k === "calendar") {
          const inst = byId.get(state.i)!;
          const handoff: Handoff = {
            nonce: state.n,
            refreshToken,
            kind: "calendar",
            exp: now() + TEN_MIN,
          };
          const sealed = seal(inst.token, handoff);
          const back = new URL("/calendar/connected", inst.url);
          back.search = new URLSearchParams({ p: sealed, s: sign(inst.token, sealed) }).toString();
          res.writeHead(302, { location: back.toString(), ...HARDENED });
          return res.end();
        }
        const codeToken = randomBytes(24).toString("base64url");
        pending.set(codeToken, { refreshToken, accessToken, state: raw!, exp: now() + TEN_MIN });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          ...HARDENED,
          // The Picker's key is restricted to the relay's origin by referrer: send the origin, no path.
          "referrer-policy": "strict-origin",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://apis.google.com https://*.googleapis.com; frame-src https://docs.google.com https://*.google.com; connect-src https://*.googleapis.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'",
        });
        return res.end(
          pickerPage({
            accessToken,
            pickerKey: o.pickerKey,
            appId: o.appId,
            state: raw!,
            codeToken,
            back: backTo(state.i),
          }),
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
        // drive.file lets through only what was picked, but the Picker is a page: check what it sent.
        const sheet = await isSpreadsheet(fileId, p.accessToken);
        if (sheet === false)
          return page(
            res,
            400,
            wordsPage(
              "That isn't a Google Sheet",
              "LUME reads Google Sheets only. Go back to LUME and pick a spreadsheet.",
              backTo(state.i),
            ),
          );
        if (sheet === "unseen")
          return page(
            res,
            400,
            wordsPage(
              "LUME couldn't see that file",
              "LUME couldn't see that file with the access you gave. Go back to LUME and pick it again.",
              backTo(state.i),
            ),
          );
        if (sheet === null)
          return plain(res, 502, "LUME couldn't check that file with Google. Go back to LUME and try again.");
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
  return Object.assign(listener, { pendingSize: () => pending.size });
}
