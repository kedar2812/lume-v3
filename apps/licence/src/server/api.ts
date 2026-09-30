import { z } from "zod";
import {
  ABSOLUTE_MS,
  changePassword,
  codeStep,
  confirmTwoStep,
  CSRF_COOKIE,
  csrfMatches,
  passwordStep,
  PENDING_COOKIE,
  sessionAdmin,
  SESSION_COOKIE,
  SIGN_IN_FAILED,
  signOut,
  startTwoStep,
  type Admin,
} from "./auth";
import {
  analytics,
  changePrice,
  createClient,
  decommission,
  dismissAlerts,
  extend,
  getClient,
  getSettings,
  listAlerts,
  listClients,
  listPayments,
  markPaid,
  newClientSchema,
  patchClientSchema,
  patchSettings,
  priceSchema,
  Refusal,
  releases,
  reminderOff,
  reminderOn,
  rotateKey,
  setSuspended,
  settingsSchema,
  updateClient,
} from "./clients";
import type { Ctx } from "./context";
import { currentRates } from "./fx";
import { clientIp, json } from "./http";

type Call = { req: Request; ctx: Ctx; params: Record<string, string>; body: unknown; admin: Admin; url: URL };
type Handler = (c: Call) => Promise<Response | unknown>;
type Route = { method: string; path: string; re: RegExp; keys: string[]; run: Handler };

const routes: Route[] = [];
function route(method: string, path: string, run: Handler) {
  const keys: string[] = [];
  const re = new RegExp(
    `^${path.replace(/:[a-z]+/gi, (m) => {
      keys.push(m.slice(1));
      return "([^/]+)";
    })}$`,
  );
  routes.push({ method, path, re, keys, run });
}
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new Refusal(400, r.error.issues[0]?.message ?? "That doesn't look right.");
  return r.data;
};

/* ---------- cookies ---------- */

function cookie(name: string, value: string, o: { maxAgeS: number; httpOnly?: boolean; path?: string }) {
  return [
    `${name}=${value}`,
    `Path=${o.path ?? "/"}`,
    `Max-Age=${o.maxAgeS}`,
    "Secure",
    "SameSite=Strict",
    ...(o.httpOnly === false ? [] : ["HttpOnly"]),
  ].join("; ");
}
function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}
const withCookies = (r: Response, cookies: string[]) => {
  for (const c of cookies) r.headers.append("set-cookie", c);
  return r;
};

/* ---------- signing in (no session yet) ---------- */

const passwordBody = z.object({ email: z.string().max(254), password: z.string().max(1024) }).strict();
const codeBody = z.object({ code: z.string().max(12) }).strict();

async function signIn(req: Request, ctx: Ctx, step: "password" | "code"): Promise<Response> {
  const ip = clientIp(req);
  const limit = ctx.limits.signIn.take(ip, ctx.now().getTime());
  if (!limit.ok) {
    await ctx.db.query("INSERT INTO sign_ins (at, ip, outcome) VALUES ($1, $2, 'limited')", [ctx.now(), ip]);
    return json(
      429,
      { error: { code: "RATE_LIMITED", message: "Too many tries. Wait a few minutes, then try again." } },
      {
        "retry-after": String(limit.retryAfterS),
      },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "That doesn't look right." } });
  }
  if (step === "password") {
    const b = passwordBody.safeParse(body);
    if (!b.success)
      return json(400, { error: { code: "BAD_REQUEST", message: "Type your email and password." } });
    const p = await passwordStep(req, ctx, b.data);
    return withCookies(json(200, { next: "code" }), [
      cookie(PENDING_COOKIE, p.pending, { maxAgeS: p.expiresS, path: "/api/auth" }),
    ]);
  }
  const b = codeBody.safeParse(body);
  const done = await codeStep(req, ctx, readCookie(req, PENDING_COOKIE), b.success ? b.data.code : "");
  const clear = cookie(PENDING_COOKIE, "", { maxAgeS: 0, path: "/api/auth" });
  if (!done.ok) return withCookies(json(401, { error: SIGN_IN_FAILED }), [clear]);
  return withCookies(json(200, { ok: true }), [
    clear,
    cookie(SESSION_COOKIE, done.session, { maxAgeS: ABSOLUTE_MS / 1000 }),
    cookie(CSRF_COOKIE, done.csrf, { maxAgeS: ABSOLUTE_MS / 1000, httpOnly: false }),
  ]);
}

/* ---------- the admin API ---------- */

route("GET", "/api/me", async ({ admin }) => ({ email: admin.email }));
route("POST", "/api/auth/sign-out", async ({ req, ctx, admin }) => {
  await signOut(req, ctx, admin);
  return withCookies(new Response(null, { status: 204 }), [
    cookie(SESSION_COOKIE, "", { maxAgeS: 0 }),
    cookie(CSRF_COOKIE, "", { maxAgeS: 0, httpOnly: false }),
  ]);
});

route("GET", "/api/clients", ({ ctx }) => listClients(ctx));
route("POST", "/api/clients", async ({ ctx, body }) =>
  json(201, await createClient(ctx, parse(newClientSchema, body))),
);
route("GET", "/api/clients/:id", ({ ctx, params }) => getClient(ctx, params.id!));
route("PATCH", "/api/clients/:id", ({ ctx, params, body }) =>
  updateClient(ctx, params.id!, parse(patchClientSchema, body)),
);
route("POST", "/api/clients/:id/price", ({ ctx, params, body }) =>
  changePrice(ctx, params.id!, parse(priceSchema, body)),
);
route("POST", "/api/clients/:id/paid", ({ ctx, params, body }) =>
  markPaid(
    ctx,
    params.id!,
    parse(z.object({ note: z.string().trim().max(500).optional() }).strict(), body ?? {}).note || null,
  ),
);
route("POST", "/api/clients/:id/extend", ({ ctx, params, body }) =>
  extend(
    ctx,
    params.id!,
    parse(z.object({ months: z.union([z.literal(1), z.literal(3), z.literal(12)]) }).strict(), body).months,
  ),
);
route("POST", "/api/clients/:id/reminder", ({ ctx, params, body }) =>
  reminderOn(
    ctx,
    params.id!,
    parse(z.object({ note: z.string().trim().max(1000).default("") }).strict(), body ?? {}).note,
  ),
);
route("DELETE", "/api/clients/:id/reminder", ({ ctx, params }) => reminderOff(ctx, params.id!));
route("POST", "/api/clients/:id/rotate", ({ ctx, params }) => rotateKey(ctx, params.id!));
route("POST", "/api/clients/:id/suspend", ({ ctx, params }) => setSuspended(ctx, params.id!, true));
route("POST", "/api/clients/:id/resume", ({ ctx, params }) => setSuspended(ctx, params.id!, false));
route("POST", "/api/clients/:id/decommission", ({ ctx, params }) => decommission(ctx, params.id!));

route("GET", "/api/payments", ({ ctx }) => listPayments(ctx));
route("GET", "/api/rates", ({ ctx }) => currentRates(ctx));
route("GET", "/api/analytics", async ({ ctx, url }) => {
  const r = url.searchParams.get("range") ?? "12";
  if (r !== "3" && r !== "6" && r !== "12") throw new Refusal(400, "The range is 3, 6 or 12 months.");
  return analytics(ctx, Number(r) as 3 | 6 | 12);
});
route("GET", "/api/alerts", ({ ctx }) => listAlerts(ctx));
route("POST", "/api/alerts/dismiss", ({ ctx, body }) =>
  dismissAlerts(
    ctx,
    parse(
      z.union([z.object({ id: z.string().max(80) }).strict(), z.object({ all: z.literal(true) }).strict()]),
      body,
    ),
  ),
);
route("GET", "/api/releases", ({ ctx }) => releases(ctx));

route("GET", "/api/settings", ({ ctx, admin }) => getSettings(ctx, admin.email));
route("PATCH", "/api/settings", ({ ctx, admin, body }) =>
  patchSettings(ctx, admin.email, parse(settingsSchema, body)),
);
route("POST", "/api/settings/password", async ({ ctx, admin, body }) => {
  const b = parse(z.object({ current: z.string().max(1024), next: z.string().max(1024) }).strict(), body);
  const problem = await changePassword(ctx, admin, b.current, b.next);
  if (problem) throw new Refusal(400, problem);
  return { ok: true };
});
route("POST", "/api/settings/two-step", ({ ctx, admin }) => startTwoStep(ctx, admin));
route("POST", "/api/settings/two-step/confirm", async ({ ctx, admin, body }) => {
  const { code } = parse(z.object({ code: z.string().max(12) }).strict(), body);
  if (!(await confirmTwoStep(ctx, admin, code)))
    throw new Refusal(400, "That code didn't match. Try the newest one.");
  return { ok: true };
});

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A write from another site is refused, whatever it carries (SameSite=Strict is the first wall; this the second). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Every /api/* request: sign-in, then a session; every write also carries the session's CSRF token. */
export async function handleApi(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  if (WRITES.has(req.method) && !sameOrigin(req))
    return json(403, { error: { code: "FORBIDDEN", message: "Not from this site." } });
  try {
    if (req.method === "POST" && url.pathname === "/api/auth/password")
      return await signIn(req, ctx, "password");
    if (req.method === "POST" && url.pathname === "/api/auth/code") return await signIn(req, ctx, "code");

    const admin = await sessionAdmin(ctx, readCookie(req, SESSION_COOKIE));
    if (!admin) return json(401, { error: { code: "SIGNED_OUT", message: "Sign in again." } });
    if (WRITES.has(req.method) && !csrfMatches(admin, req.headers.get("x-csrf-token")))
      return json(403, { error: { code: "CSRF", message: "Reload the page, then try again." } });

    let match: { r: Route; m: RegExpExecArray } | null = null;
    for (const r of routes) {
      const m = r.method === req.method ? r.re.exec(url.pathname) : null;
      if (m) {
        match = { r, m };
        break;
      }
    }
    if (!match) return json(404, { error: { code: "NOT_FOUND", message: "Nothing here." } });
    const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1]!)]));
    let body: unknown = undefined;
    if (WRITES.has(req.method)) {
      const text = await req.text();
      if (text.length > 64_000) throw new Refusal(400, "Too large.");
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new Refusal(400, "That doesn't look right.");
      }
    }
    const out = await match.r.run({ req, ctx, params, body, admin, url });
    return out instanceof Response ? out : json(200, out);
  } catch (e) {
    if (e instanceof Refusal)
      return json(e.status, {
        error: { code: e.status === 404 ? "NOT_FOUND" : "REFUSED", message: e.message },
      });
    throw e;
  }
}
