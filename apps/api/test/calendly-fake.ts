import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Calendly API v2 calls LUME makes (5B), over real HTTP: who the token is, and webhook
 * subscriptions. It answers as Calendly does where LUME depends on it:
 * - 401 for a bad token;
 * - 403 "upgrade" on a plan without webhooks;
 * - 403 for organization scope when the token's person isn't an org admin;
 * - 409 for a second subscription to one URL.
 * `signed` makes a delivery exactly as Calendly signs one, for the tests to post to LUME.
 */
export type FakeSubscription = {
  uri: string;
  callbackUrl: string;
  scope: "organization" | "user";
  signingKey: string;
  events: string[];
};
export type CalendlyFake = {
  url: string;
  /** A token Calendly accepts. */
  token: string;
  user: { uri: string; name: string; email: string };
  organization: string;
  /** The token's person administers the organization (organization-scoped subscriptions allowed). */
  orgAdmin: boolean;
  /** A free plan: Calendly refuses every subscription. */
  freePlan: boolean;
  subscriptions: FakeSubscription[];
  /** The next `count` calls answer with this status. */
  fail(status: number, count?: number): void;
  /** Every call's method and path, in order. */
  calls: string[];
  /** A delivery to a subscription, signed as Calendly signs it: the headers and the raw body. */
  signed(
    sub: FakeSubscription,
    body: unknown,
    at?: number,
  ): { headers: Record<string, string>; payload: string };
  close(): Promise<void>;
};

const BASE = "https://api.calendly.com";

export async function startCalendlyFake(): Promise<CalendlyFake> {
  const token = `cal_${randomBytes(12).toString("hex")}`;
  const subscriptions: FakeSubscription[] = [];
  const calls: string[] = [];
  let failing: { status: number; left: number } | null = null;
  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString("utf8")));
      req.on("end", () => resolve(b));
    });
  const asCalendly = (s: FakeSubscription) => ({
    uri: s.uri,
    callback_url: s.callbackUrl,
    scope: s.scope,
    events: s.events,
    organization: api.organization,
    user: s.scope === "user" ? api.user.uri : null,
    state: "active",
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake");
    calls.push(`${req.method} ${u.pathname}`);
    if (failing && failing.left > 0) {
      failing.left--;
      return send(res, failing.status, { title: "Service Unavailable", message: "fake failure" });
    }
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(res, 401, { title: "Unauthenticated", message: "The access token is invalid" });
    if (u.pathname === "/users/me" && req.method === "GET")
      return send(res, 200, {
        resource: { ...api.user, current_organization: api.organization, slug: "maya" },
      });
    if (u.pathname === "/webhook_subscriptions" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}") as {
        url: string;
        events: string[];
        organization: string;
        user?: string;
        scope: "organization" | "user";
        signing_key: string;
      };
      if (api.freePlan)
        return send(res, 403, {
          title: "Permission Denied",
          message: "Please upgrade your Calendly account to Standard",
        });
      if (b.scope === "organization" && !api.orgAdmin)
        return send(res, 403, {
          title: "Permission Denied",
          message: "You do not have permission to access this resource.",
        });
      if (subscriptions.some((s) => s.callbackUrl === b.url))
        return send(res, 409, { title: "Already Exists", message: "Hook with this url already exists" });
      const s: FakeSubscription = {
        uri: `${BASE}/webhook_subscriptions/${randomBytes(8).toString("hex")}`,
        callbackUrl: b.url,
        scope: b.scope,
        signingKey: b.signing_key,
        events: b.events,
      };
      subscriptions.push(s);
      return send(res, 201, { resource: asCalendly(s) });
    }
    if (u.pathname === "/webhook_subscriptions" && req.method === "GET") {
      const scope = u.searchParams.get("scope");
      return send(res, 200, {
        collection: subscriptions.filter((s) => !scope || s.scope === scope).map(asCalendly),
        pagination: { next_page: null },
      });
    }
    const one = /^\/webhook_subscriptions\/([^/]+)$/.exec(u.pathname);
    if (one && req.method === "DELETE") {
      const i = subscriptions.findIndex((s) => s.uri.endsWith(`/${one[1]}`));
      if (i < 0) return send(res, 404, { title: "Resource Not Found", message: "" });
      subscriptions.splice(i, 1);
      return send(res, 204);
    }
    return send(res, 404, { title: "Resource Not Found", message: "Unknown path" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api: CalendlyFake = {
    url,
    token,
    user: { uri: `${BASE}/users/MAYA0001`, name: "Maya Kapoor", email: "maya@business.test" },
    organization: `${BASE}/organizations/ORG0001`,
    orgAdmin: true,
    freePlan: false,
    subscriptions,
    fail(status, count = 1) {
      failing = { status, left: count };
    },
    calls,
    signed(sub, body, at = Date.now()) {
      const payload = JSON.stringify(body);
      const t = Math.floor(at / 1000);
      const v1 = createHmac("sha256", sub.signingKey).update(`${t}.${payload}`).digest("hex");
      return {
        headers: { "content-type": "application/json", "calendly-webhook-signature": `t=${t},v1=${v1}` },
        payload,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}
