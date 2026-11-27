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
  /** Calendly disables a subscription when its person loses access or the plan drops webhooks. */
  state?: "active" | "disabled";
};
/** One of the account's scheduling links (an event type), as the fake keeps it. */
export type FakeLink = {
  uri: string;
  name: string;
  duration: number;
  owner: string;
  active?: boolean;
  paid?: boolean;
  pooling?: string | null;
  locations?: { kind: string; location?: string | null }[];
  questions?: { name: string; required: boolean; enabled?: boolean }[];
  /** Free start times (ISO), as Calendly's availability answers them. */
  free?: string[];
};
/** A booking LUME made through the Scheduling API. */
export type FakeBooking = {
  uri: string;
  event: string;
  body: {
    event_type: string;
    start_time: string;
    invitee: { name: string; email: string; timezone: string };
    location?: { kind: string; location?: string };
    questions_and_answers?: { question: string; answer: string; position: number }[];
  };
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
  /** The account's links (event types): the organization's, or the token's person's own. */
  links: FakeLink[];
  /** Bookings made with POST /invitees, in order. */
  bookings: FakeBooking[];
  /** Scheduled events LUME cancelled. */
  cancelled: string[];
  /** The next booking's id (its invitee and event URIs end in it), for a test that must know it before. */
  nextBookingId?: string;
  /** The next `count` calls answer with this status. */
  fail(status: number, count?: number): void;
  /** The token is revoked (every call 401) until restored. */
  revoked: boolean;
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
    if (api.revoked || req.headers.authorization !== `Bearer ${token}`)
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
    if (one && req.method === "GET") {
      const s = subscriptions.find((x) => x.uri.endsWith(`/${one[1]}`));
      if (!s) return send(res, 404, { title: "Resource Not Found", message: "" });
      return send(res, 200, { resource: { ...asCalendly(s), state: s.state ?? "active" } });
    }
    if (one && req.method === "DELETE") {
      const i = subscriptions.findIndex((s) => s.uri.endsWith(`/${one[1]}`));
      if (i < 0) return send(res, 404, { title: "Resource Not Found", message: "" });
      subscriptions.splice(i, 1);
      return send(res, 204);
    }
    if (u.pathname === "/event_types" && req.method === "GET") {
      const org = u.searchParams.get("organization");
      if (org && !api.orgAdmin)
        return send(res, 403, { title: "Permission Denied", message: "You do not have permission" });
      const wantActive = u.searchParams.get("active") === "true";
      return send(res, 200, {
        collection: api.links
          .filter((l) => !wantActive || l.active !== false)
          .map((l) => ({
            uri: l.uri,
            name: l.name,
            duration: l.duration,
            active: l.active !== false,
            scheduling_url: `https://calendly.com/maya/${l.uri.split("/").at(-1)}`,
            pooling_type: l.pooling ?? null,
            is_paid: !!l.paid,
            profile: { name: l.owner, type: "User" },
            locations: l.locations ?? null,
            custom_questions: (l.questions ?? []).map((q) => ({
              ...q,
              enabled: q.enabled !== false,
              type: "string",
            })),
          })),
        pagination: { next_page_token: null },
      });
    }
    if (u.pathname === "/event_type_available_times" && req.method === "GET") {
      const l = api.links.find((x) => x.uri === u.searchParams.get("event_type"));
      if (!l) return send(res, 404, { title: "Resource Not Found", message: "" });
      const from = Date.parse(u.searchParams.get("start_time") ?? "");
      const to = Date.parse(u.searchParams.get("end_time") ?? "");
      if (!(to > from) || to - from > 7 * 24 * 3_600_000)
        return send(res, 400, { title: "Invalid Argument", message: "The supplied parameters are invalid." });
      return send(res, 200, {
        collection: (l.free ?? [])
          .filter((t) => Date.parse(t) >= from && Date.parse(t) < to)
          .map((t) => ({ status: "available", start_time: t, invitees_remaining: 1 })),
      });
    }
    if (u.pathname === "/invitees" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}") as FakeBooking["body"];
      const l = api.links.find((x) => x.uri === b.event_type);
      if (!l) return send(res, 404, { title: "Resource Not Found", message: "" });
      if (l.paid)
        return send(res, 400, {
          title: "Invalid Argument",
          message: "Event types that require payment cannot be scheduled via the API.",
        });
      if (!(l.free ?? []).includes(b.start_time))
        return send(res, 400, {
          title: "Invalid Argument",
          message: "The selected time is no longer available.",
        });
      const kinds = (l.locations ?? []).map((x) => x.kind);
      if (kinds.length && (!b.location || !kinds.includes(b.location.kind)))
        return send(res, 400, {
          title: "Invalid Argument",
          message: "Specified location kind is not configured for this event type.",
        });
      const asked = new Set((b.questions_and_answers ?? []).map((q) => q.question));
      if ((l.questions ?? []).some((q) => q.required && q.enabled !== false && !asked.has(q.name)))
        return send(res, 400, {
          title: "Invalid Argument",
          message: "Required Questions and Answers cannot be blank.",
        });
      const id = api.nextBookingId ?? randomBytes(8).toString("hex");
      delete api.nextBookingId;
      const booking: FakeBooking = {
        uri: `${BASE}/scheduled_events/EV${id}/invitees/IN${id}`,
        event: `${BASE}/scheduled_events/EV${id}`,
        body: b,
      };
      api.bookings.push(booking);
      l.free = (l.free ?? []).filter((t) => t !== b.start_time);
      return send(res, 201, {
        resource: { uri: booking.uri, event: booking.event, status: "active", scheduling_method: "api" },
      });
    }
    const cancel = /^\/scheduled_events\/([^/]+)\/cancellation$/.exec(u.pathname);
    if (cancel && req.method === "POST") {
      const b = api.bookings.find((x) => x.event.endsWith(`/${cancel[1]}`));
      if (!b) return send(res, 404, { title: "Resource Not Found", message: "" });
      api.cancelled.push(b.event);
      return send(res, 201, { resource: { canceled_by: "LUME", reason: "x" } });
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
    revoked: false,
    subscriptions,
    links: [],
    bookings: [],
    cancelled: [],
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
