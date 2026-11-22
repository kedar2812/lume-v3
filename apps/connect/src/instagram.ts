import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { metaSignatureOk, relaySign, seal, sign, verify, type Handoff } from "@lume/core";
import type { RouteStore } from "./routes-store";

/**
 * Instagram at the relay (NEW_FEATURES_PLAN §4.2; plan 1A Task 2). Instagram API with Instagram Login: the relay holds
 * the Instagram app secret, runs the sign-in, keeps the routing table (account → client's LUME) and passes Meta's
 * deliveries on, each client getting only its own accounts' entries. Message text passes through in memory only.
 */
export type InstagramConfig = {
  appId: string;
  appSecret: string;
  verifyToken: string;
  /** The Meta app's own secret, if set: also accepted on deliveries until the test account shows which one signs. */
  metaAppSecret?: string;
  oauthUrl: string;
  tokenUrl: string;
  graphUrl: string;
  version: string;
};
type Instance = { url: string; token: string };
type State = { i: string; n: string; exp: number; k?: string };
export type InstagramContext = {
  ig: InstagramConfig;
  routes: RouteStore;
  publicUrl: string;
  now: () => number;
  byId: Map<string, Instance>;
  byToken: Map<string, Instance>;
  instanceIdOf: (token: string) => string;
  packState: (s: State & { k: "instagram" }) => string;
  readState: (raw: string | null) => State | null;
  plain: (res: http.ServerResponse, status: number, text: string) => void;
  page: (res: http.ServerResponse, status: number, html: string) => void;
  wordsPage: (title: string, text: string, back: string | null) => string;
  backTo: (instanceId: string) => string | null;
  formBody: (req: http.IncomingMessage) => Promise<string>;
  /** The relay's own signature on "this account was connected to this LUME" (only the relay can make one). */
  grant: (accountId: string, instanceId: string) => string;
  grantOk: (accountId: string, instanceId: string, grant: string) => boolean;
  log?: (msg: string) => void;
};

export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];
export const IG_FIELDS = [
  "messages",
  "messaging_postbacks",
  "messaging_referral",
  "messaging_seen",
  "message_reactions",
  "comments",
  "live_comments",
];
const TEN_MIN = 10 * 60_000;
/** A client's LUME failing for less than this keeps Meta retrying the batch; past it, the relay notes a gap instead. */
export const HOLD_MS = 15 * 60_000;
const BODY_MAX = 3 * 1024 * 1024;
const IG_ID = /^\d{5,30}$/;
const HARDENED = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

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

/** Meta's signed_request (deauthorize, data deletion): `<sig>.<payload>`, HMAC-SHA256 of the payload. */
export function readSignedRequest(secret: string, raw: string | null): { userId: string } | null {
  if (!raw) return null;
  const [sig, payload] = raw.split(".");
  if (!sig || !payload) return null;
  const want = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      algorithm?: string;
      user_id?: unknown;
    };
    const userId = typeof p.user_id === "string" || typeof p.user_id === "number" ? String(p.user_id) : "";
    return p.algorithm?.toUpperCase() === "HMAC-SHA256" && IG_ID.test(userId) ? { userId } : null;
  } catch {
    return null;
  }
}

export function instagramRoutes(c: InstagramContext) {
  const log = c.log ?? ((m: string) => console.log(m));
  const graph = (path: string, q: Record<string, string>) =>
    `${c.ig.graphUrl}/${c.ig.version}/${path}?${new URLSearchParams(q)}`;
  const getJson = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const data = ((await r?.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { ok: !!r?.ok, data };
  };
  /** The first time this instance failed in the current streak; cleared when it answers. */
  const failingSince = new Map<string, number>();
  let signerLogged = false;

  /** POST signed JSON to an instance's LUME. */
  const toInstance = async (inst: Instance, path: string, body: unknown, timeoutMs = 10_000) => {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(c.now() / 1000));
    const r = await fetch(new URL(path, inst.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lume-timestamp": ts,
        "x-lume-signature": relaySign(inst.token, ts, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    return !!r?.ok;
  };
  const bearerInstance = (req: http.IncomingMessage) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const inst = t ? c.byToken.get(t) : undefined;
    return inst ? c.instanceIdOf(inst.token) : null;
  };
  const answer = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", ...HARDENED });
    res.end(JSON.stringify(body));
  };
  const jsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    try {
      const v = JSON.parse((await c.formBody(req)) || "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  /** Rebuild the routing table from each instance's own list (on start): an instance that doesn't answer keeps its routes. */
  async function rebuild(): Promise<void> {
    await Promise.all(
      [...c.byId.entries()].map(async ([id, inst]) => {
        const ts = String(Math.floor(c.now() / 1000));
        const r = await fetch(new URL("/instagram/accounts", inst.url), {
          headers: { "x-lume-timestamp": ts, "x-lume-signature": relaySign(inst.token, ts, Buffer.alloc(0)) },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (!r?.ok) return;
        const d = (await r.json().catch(() => null)) as { accounts?: unknown } | null;
        if (!Array.isArray(d?.accounts)) return;
        // Only an account the relay itself granted this LUME at connect: a LUME can't claim another's account.
        const mine = (d.accounts as { id?: unknown; grant?: unknown }[])
          .filter(
            (a) =>
              typeof a?.id === "string" &&
              IG_ID.test(a.id) &&
              typeof a.grant === "string" &&
              c.grantOk(a.id, id, a.grant),
          )
          .map((a) => a.id as string);
        c.routes.replaceFor(id, mine);
      }),
    );
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<boolean> {
    if (u.pathname === "/ig/start" && req.method === "GET") {
      const id = u.searchParams.get("i") ?? "";
      const n = u.searchParams.get("n") ?? "";
      const inst = c.byId.get(id);
      if (!inst || !n || !verify(inst.token, `${n}.instagram`, u.searchParams.get("s") ?? "")) {
        c.plain(res, 400, "This link isn't valid. Go back to LUME and try again.");
        return true;
      }
      const to = new URL(c.ig.oauthUrl);
      to.search = new URLSearchParams({
        client_id: c.ig.appId,
        redirect_uri: `${c.publicUrl}/ig/callback`,
        response_type: "code",
        scope: IG_SCOPES.join(","),
        state: c.packState({ i: id, n, exp: c.now() + TEN_MIN, k: "instagram" }),
      }).toString();
      res.writeHead(302, { location: to.toString(), ...HARDENED });
      res.end();
      return true;
    }

    if (u.pathname === "/ig/callback" && req.method === "GET") {
      const state = c.readState(u.searchParams.get("state"));
      if (!state || state.k !== "instagram") {
        c.plain(res, 400, "This sign-in expired or isn't valid. Go back to LUME and try again.");
        return true;
      }
      const back = c.backTo(state.i);
      const refused = (text: string) => c.page(res, 400, c.wordsPage("Instagram didn't connect", text, back));
      if (u.searchParams.get("error")) {
        refused(
          "Instagram wasn't connected, because the sign-in was cancelled. You can try again from LUME.",
        );
        return true;
      }
      // Instagram adds "#_" after the code; a browser drops it, but a copied link may not.
      const code = (u.searchParams.get("code") ?? "").replace(/#_$/, "");
      if (!code) {
        refused("Instagram didn't send LUME a sign-in. Go back to LUME and choose Connect again.");
        return true;
      }
      const short = await getJson(c.ig.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.ig.appId,
          client_secret: c.ig.appSecret,
          grant_type: "authorization_code",
          redirect_uri: `${c.publicUrl}/ig/callback`,
          code,
        }),
      });
      // Meta answers `{data:[{access_token, user_id, permissions}]}`; older answers put them at the top.
      const first = (Array.isArray(short.data.data) ? short.data.data[0] : short.data) as
        { access_token?: unknown; permissions?: unknown } | undefined;
      const shortToken = typeof first?.access_token === "string" ? first.access_token : "";
      if (!short.ok || !shortToken) {
        refused("Instagram didn't give LUME access. Go back to LUME and choose Connect again.");
        return true;
      }
      const granted =
        typeof first?.permissions === "string"
          ? first.permissions.split(",").map((p) => p.trim())
          : Array.isArray(first?.permissions)
            ? (first.permissions as unknown[]).map(String)
            : IG_SCOPES;
      if (!IG_SCOPES.every((s) => granted.includes(s))) {
        refused(
          "LUME needs every permission on Instagram's screen: to read your account, and to read and answer messages and comments. Choose Connect again and leave them all on.",
        );
        return true;
      }
      const long = await getJson(
        `${c.ig.graphUrl}/access_token?${new URLSearchParams({
          grant_type: "ig_exchange_token",
          client_secret: c.ig.appSecret,
          access_token: shortToken,
        })}`,
      );
      const token = typeof long.data.access_token === "string" ? long.data.access_token : "";
      if (!long.ok || !token) {
        refused("Instagram didn't give LUME lasting access. Go back to LUME and choose Connect again.");
        return true;
      }
      const me = await getJson(
        graph("me", { fields: "user_id,username,name,account_type", access_token: token }),
      );
      const userId = me.data.user_id === undefined ? "" : String(me.data.user_id);
      const username = typeof me.data.username === "string" ? me.data.username : "";
      if (!me.ok || !IG_ID.test(userId) || !username) {
        refused("LUME couldn't read the Instagram account. Go back to LUME and choose Connect again.");
        return true;
      }
      const accountType = typeof me.data.account_type === "string" ? me.data.account_type : null;
      if (accountType && !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(accountType.toUpperCase())) {
        refused(
          "Instagram only lets LUME connect a professional account (Business or Creator). Switch the account to professional in Instagram's settings, then connect again.",
        );
        return true;
      }
      const sub = await getJson(
        graph(`${userId}/subscribed_apps`, { subscribed_fields: IG_FIELDS.join(","), access_token: token }),
        { method: "POST" },
      );
      if (!sub.ok || sub.data.success !== true) {
        refused("Instagram didn't let LUME finish connecting. Go back to LUME and choose Connect again.");
        return true;
      }
      const inst = c.byId.get(state.i)!;
      const was = c.routes.set(userId, state.i);
      // The account was on another LUME (a client moved servers): that one hears it, best effort.
      if (was && was !== state.i) {
        const other = c.byId.get(was);
        if (other) void toInstance(other, "/instagram/moved", { accountId: userId });
      }
      const handoff: Handoff = {
        nonce: state.n,
        kind: "instagram",
        instagram: {
          token,
          grant: c.grant(userId, state.i),
          expiresIn: typeof long.data.expires_in === "number" ? long.data.expires_in : 5_184_000,
          userId,
          username,
          name: typeof me.data.name === "string" && me.data.name ? me.data.name : null,
          accountType,
        },
        exp: c.now() + TEN_MIN,
      };
      const sealed = seal(inst.token, handoff);
      const to = new URL("/settings/integrations/instagram/connected", inst.url);
      to.search = new URLSearchParams({ p: sealed, s: sign(inst.token, sealed) }).toString();
      res.writeHead(302, { location: to.toString(), ...HARDENED });
      res.end();
      return true;
    }

    if (u.pathname === "/ig/in" && req.method === "GET") {
      const ok =
        u.searchParams.get("hub.mode") === "subscribe" &&
        u.searchParams.get("hub.verify_token") === c.ig.verifyToken;
      if (!ok) c.plain(res, 403, "Forbidden");
      else {
        res.writeHead(200, { "content-type": "text/plain", ...HARDENED });
        res.end(u.searchParams.get("hub.challenge") ?? "");
      }
      return true;
    }

    if (u.pathname === "/ig/in" && req.method === "POST") {
      const raw = await rawBody(req, BODY_MAX);
      if (raw === "too_large") {
        c.plain(res, 413, "Too large");
        return true;
      }
      const h = req.headers["x-hub-signature-256"];
      const sig = Array.isArray(h) ? h[0] : h;
      const byIg = metaSignatureOk(c.ig.appSecret, raw, sig);
      const byMeta = !byIg && !!c.ig.metaAppSecret && metaSignatureOk(c.ig.metaAppSecret, raw, sig);
      if (!byIg && !byMeta) {
        c.plain(res, 401, "Unauthorized");
        return true;
      }
      if (!signerLogged) {
        signerLogged = true;
        log(`instagram: deliveries are signed with the ${byIg ? "Instagram" : "Meta"} app secret`);
      }
      let body: { object?: unknown; entry?: unknown };
      try {
        body = JSON.parse(raw.toString("utf8")) as typeof body;
      } catch {
        c.plain(res, 200, "ok");
        return true;
      }
      if (body?.object !== "instagram" || !Array.isArray(body.entry)) {
        c.plain(res, 200, "ok");
        return true;
      }
      // Each client gets only its own accounts' entries; an account no LUME holds is dropped (nothing kept).
      const groups = new Map<string, unknown[]>();
      for (const e of body.entry as unknown[]) {
        const acct = (e as { id?: unknown } | null)?.id;
        const inst = acct === undefined || acct === null ? undefined : c.routes.get(String(acct));
        if (!inst || !c.byId.has(inst)) continue;
        groups.set(inst, [...(groups.get(inst) ?? []), e]);
      }
      const now = c.now();
      const results = await Promise.all(
        [...groups.entries()].map(async ([id, entries]) => {
          const ok = await toInstance(c.byId.get(id)!, "/instagram/in", {
            object: "instagram",
            entry: entries,
          });
          if (ok) {
            failingSince.delete(id);
            return true;
          }
          const since = failingSince.get(id) ?? now;
          failingSince.set(id, since);
          if (now - since < HOLD_MS) return false;
          // Down too long to hold every other client's batch: noted, so it catches up from Meta when it's back.
          const accounts = entries.map((e) => String((e as { id: unknown }).id));
          c.routes.gap(id, accounts, since, now);
          return true;
        }),
      );
      const held = results.some((r) => !r);
      c.plain(res, held ? 503 : 200, held ? "Try again" : "ok");
      return true;
    }

    if ((u.pathname === "/ig/deauthorize" || u.pathname === "/ig/delete") && req.method === "POST") {
      const f = new URLSearchParams(await c.formBody(req));
      const sr =
        readSignedRequest(c.ig.appSecret, f.get("signed_request")) ??
        (c.ig.metaAppSecret ? readSignedRequest(c.ig.metaAppSecret, f.get("signed_request")) : null);
      if (!sr) {
        c.plain(res, 400, "Bad request");
        return true;
      }
      const kind = u.pathname === "/ig/delete" ? "delete" : "deauthorize";
      // Kept as a note until each LUME that holds or held the account takes it: a request never lost to downtime,
      // to a disconnect before it, or to a move.
      for (const id of c.routes.holders(sr.userId)) {
        if (!c.byId.has(id)) continue;
        c.routes.note(id, { kind, userId: sr.userId });
        void toInstance(c.byId.get(id)!, "/instagram/notes", {});
      }
      if (kind === "delete") {
        const code = randomBytes(9).toString("base64url");
        answer(res, 200, { url: `${c.publicUrl}/ig/deletion?code=${code}`, confirmation_code: code });
      } else answer(res, 200, { ok: true });
      return true;
    }
    if (u.pathname === "/ig/deletion" && req.method === "GET") {
      c.page(
        res,
        200,
        c.wordsPage(
          "Your request was received",
          "LUME removes what Instagram sent it about this account from the business's LUME. Nothing else is needed from you.",
          null,
        ),
      );
      return true;
    }

    // An instance's own calls: its token as Bearer.
    if (u.pathname === "/ig/forget" && req.method === "POST") {
      const id = bearerInstance(req);
      if (!id) {
        answer(res, 401, { error: "unknown_instance" });
        return true;
      }
      const b = await jsonBody(req);
      const acct = typeof b.accountId === "string" ? b.accountId : "";
      if (!IG_ID.test(acct)) {
        answer(res, 400, { error: "bad_request" });
        return true;
      }
      answer(res, 200, { dropped: c.routes.drop(acct, id) });
      return true;
    }
    if (u.pathname === "/ig/notes" && req.method === "GET") {
      const id = bearerInstance(req);
      if (!id) answer(res, 401, { error: "unknown_instance" });
      else answer(res, 200, { notes: c.routes.notesFor(id) });
      return true;
    }
    if (u.pathname === "/ig/notes/clear" && req.method === "POST") {
      const id = bearerInstance(req);
      if (!id) {
        answer(res, 401, { error: "unknown_instance" });
        return true;
      }
      const b = await jsonBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string") : [];
      answer(res, 200, { cleared: c.routes.clear(id, ids.slice(0, 5_000)) });
      return true;
    }
    return false;
  }

  return { handle, rebuild };
}
