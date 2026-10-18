import type http from "node:http";
import { metaSignatureOk, relaySign, seal, sign, verify, type Handoff } from "@lume/core";
import { signupPage } from "./signup.html";

/** Meta's app, as the relay holds it (spec 2026-10-18 §3.1): the secret never leaves the relay. */
export type MetaConfig = {
  appId: string;
  appSecret: string;
  /** The Embedded Signup configuration, set up for existing WhatsApp Business app numbers (coexistence). */
  configId: string;
  /** What Meta's webhook handshake must say. */
  verifyToken: string;
  graphUrl: string;
  version: string;
};
type Instance = { url: string; token: string };
type State = { i: string; n: string; exp: number; k?: string };
export type WhatsAppContext = {
  meta: MetaConfig;
  publicUrl: string;
  now: () => number;
  byId: Map<string, Instance>;
  packState: (s: State & { k: "whatsapp" }) => string;
  readState: (raw: string | null) => State | null;
  plain: (res: http.ServerResponse, status: number, text: string) => void;
  page: (res: http.ServerResponse, status: number, html: string) => void;
  wordsPage: (title: string, text: string, back: string | null) => string;
  backTo: (instanceId: string) => string | null;
  formBody: (req: http.IncomingMessage) => Promise<string>;
};

const TEN_MIN = 10 * 60_000;
const BODY_MAX = 3 * 1024 * 1024;
const META_ID = /^\d{5,30}$/;
const HARDENED = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The raw bytes, or "too_large" past `max` (Meta's history chunks can be big; nothing bigger is read). */
function rawBody(req: http.IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? "too_large" : Buffer.concat(chunks)));
  });
}

/**
 * WhatsApp at the relay (spec 2026-10-18 §3.2–3.3, Decision 1): Embedded Signup for a client's existing number, and
 * Meta's deliveries passed on to that client's LUME. Each client's WhatsApp account is subscribed with its own
 * callback here (`/wa/in/<instanceId>`), so the relay needs no list of numbers and keeps nothing: message text
 * passes through in memory only. Answers `false` for a path that isn't its own.
 */
export function whatsappRoutes(c: WhatsAppContext) {
  const graph = (path: string) => `${c.meta.graphUrl}/${c.meta.version}/${path}`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(graph(path), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    return { ok: !!r?.ok, data: ((await r?.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<boolean> => {
    if (u.pathname === "/wa/start" && req.method === "GET") {
      const id = u.searchParams.get("i") ?? "";
      const n = u.searchParams.get("n") ?? "";
      const inst = c.byId.get(id);
      // The kind is signed with the nonce: a sheet's or a calendar's link can't start this.
      if (!inst || !n || !verify(inst.token, `${n}.whatsapp`, u.searchParams.get("s") ?? "")) {
        c.plain(res, 400, "This link isn't valid. Go back to LUME and try again.");
        return true;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...HARDENED,
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline' https://connect.facebook.net; frame-src https://www.facebook.com https://web.facebook.com; connect-src https://*.facebook.com https://graph.facebook.com; img-src 'self' data: https:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(
        signupPage({
          appId: c.meta.appId,
          configId: c.meta.configId,
          version: c.meta.version,
          state: c.packState({ i: id, n, exp: c.now() + TEN_MIN, k: "whatsapp" }),
          back: c.backTo(id),
        }),
      );
      return true;
    }

    if (u.pathname === "/wa/done" && req.method === "POST") {
      const f = new URLSearchParams(await c.formBody(req));
      const state = c.readState(f.get("state"));
      const code = f.get("code") ?? "";
      const waba = f.get("waba_id") ?? "";
      const phone = f.get("phone_number_id") ?? "";
      if (!state || state.k !== "whatsapp" || !code || !META_ID.test(waba) || !META_ID.test(phone)) {
        c.plain(res, 400, "This connection expired or isn't valid. Go back to LUME and try again.");
        return true;
      }
      const inst = c.byId.get(state.i)!;
      const refused = (text: string) =>
        c.page(res, 400, c.wordsPage("WhatsApp didn't connect", text, c.backTo(state.i)));
      const ex = await fetch(
        `${graph("oauth/access_token")}?${new URLSearchParams({ client_id: c.meta.appId, client_secret: c.meta.appSecret, code })}`,
        { signal: AbortSignal.timeout(15_000) },
      ).catch(() => null);
      const token = ex?.ok
        ? ((await ex.json().catch(() => ({}))) as { access_token?: string }).access_token
        : undefined;
      if (!token) {
        refused("Meta didn't give LUME access to the number. Go back to LUME and choose Connect again.");
        return true;
      }
      // Meta delivers this account's messages to this LUME's own address here.
      const sub = await call("POST", `${waba}/subscribed_apps`, token, {
        override_callback_uri: `${c.publicUrl}/wa/in/${state.i}`,
        verify_token: c.meta.verifyToken,
      });
      const num = await call("GET", `${phone}?fields=display_phone_number,verified_name`, token);
      if (!sub.ok || !num.ok) {
        refused(
          "Meta didn't let LUME finish connecting the number. Go back to LUME and choose Connect again.",
        );
        return true;
      }
      // Contacts, then past chats (the person chose whether to share them in Meta's popup). A refused sync is said
      // on LUME's side; the number still connects.
      await call("POST", `${phone}/smb_app_data`, token, {
        messaging_product: "whatsapp",
        sync_type: "smb_app_state_sync",
      });
      const history = await call("POST", `${phone}/smb_app_data`, token, {
        messaging_product: "whatsapp",
        sync_type: "history",
      });
      const handoff: Handoff = {
        nonce: state.n,
        kind: "whatsapp",
        whatsapp: {
          token,
          wabaId: waba,
          phoneNumberId: phone,
          display: String(num.data.display_phone_number ?? phone),
          name: typeof num.data.verified_name === "string" ? num.data.verified_name : null,
          history: history.ok,
        },
        exp: c.now() + TEN_MIN,
      };
      const sealed = seal(inst.token, handoff);
      const back = new URL("/settings/integrations/whatsapp/connected", inst.url);
      back.search = new URLSearchParams({ p: sealed, s: sign(inst.token, sealed) }).toString();
      res.writeHead(302, { location: back.toString(), ...HARDENED });
      res.end();
      return true;
    }

    const m = /^\/wa\/in\/([0-9a-f]{16})$/.exec(u.pathname);
    if (m && req.method === "GET") {
      const ok =
        c.byId.has(m[1]!) &&
        u.searchParams.get("hub.mode") === "subscribe" &&
        u.searchParams.get("hub.verify_token") === c.meta.verifyToken;
      if (!ok) c.plain(res, 403, "Forbidden");
      else {
        res.writeHead(200, { "content-type": "text/plain", ...HARDENED });
        res.end(u.searchParams.get("hub.challenge") ?? "");
      }
      return true;
    }
    if (m && req.method === "POST") {
      const raw = await rawBody(req, BODY_MAX);
      if (raw === "too_large") {
        c.plain(res, 413, "Too large");
        return true;
      }
      const sig = req.headers["x-hub-signature-256"];
      if (!metaSignatureOk(c.meta.appSecret, raw, Array.isArray(sig) ? sig[0] : sig)) {
        c.plain(res, 401, "Unauthorized");
        return true;
      }
      const inst = c.byId.get(m[1]!);
      if (!inst) {
        c.plain(res, 404, "Not found");
        return true;
      }
      const ts = String(Math.floor(c.now() / 1000));
      const r = await fetch(new URL("/whatsapp/in", inst.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lume-timestamp": ts,
          "x-lume-signature": relaySign(inst.token, ts, raw),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      // Meta keeps trying a delivery that didn't get a 200: only a 2xx from the client's LUME counts.
      c.plain(res, r?.ok ? 200 : 503, r?.ok ? "ok" : "Try again");
      return true;
    }
    return false;
  };
}
