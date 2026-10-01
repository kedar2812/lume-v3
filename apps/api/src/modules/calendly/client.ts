/**
 * Calendly's API v2, as LUME uses it (5B, spec §3): who a personal access token is, and LUME's own webhook
 * subscription. The token is never written into an error, a log line or a response.
 */
export type CalendlyErrorKind =
  "token" | "plan" | "forbidden" | "not_found" | "conflict" | "unavailable" | "bad_request";

export class CalendlyError extends Error {
  constructor(
    readonly kind: CalendlyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CalendlyError";
  }
}

export type CalendlyMe = { uri: string; name: string; email: string; organization: string };
export type Subscription = { uri: string; scope: "organization" | "user" };

export type Calendly = {
  me(): Promise<CalendlyMe>;
  /**
   * Bookings and cancellations to `url`, signed with `signingKey`: the organization's when the token's person
   * administers it, else their own. One already at that address is replaced, so LUME holds its key.
   */
  subscribe(o: {
    url: string;
    signingKey: string;
    organization: string;
    user: string;
  }): Promise<Subscription>;
  unsubscribe(uri: string): Promise<void>;
  /** Whether Calendly still sends to LUME's subscription (it disables one when the plan or access changes). */
  subscription(uri: string): Promise<{ state: string }>;
};

export const CALENDLY_EVENTS = ["invitee.created", "invitee.canceled"];
const RETRIES = [1000, 2000, 4000];

export function createCalendly(o: {
  token: string;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Calendly {
  const base = o.endpoint ?? "https://api.calendly.com";
  const http = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await http(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${o.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        res = null; // the network failed: as a 503
      }
      const status = res?.status ?? 503;
      if (res?.ok) return (status === 204 ? undefined : await res.json()) as T;
      if ((status >= 500 || status === 429) && attempt < RETRIES.length) {
        await sleep(RETRIES[attempt]!);
        continue;
      }
      const j = res ? ((await res.json().catch(() => ({}))) as { message?: string }) : {};
      const said = String(j.message ?? "");
      if (status === 401) throw new CalendlyError("token", "Calendly didn't accept the access token.");
      if (status === 403 && /upgrade/i.test(said))
        throw new CalendlyError("plan", "Calendly's plan doesn't send bookings to other apps.");
      if (status === 403) throw new CalendlyError("forbidden", "Calendly didn't allow that.");
      if (status === 404) throw new CalendlyError("not_found", "Calendly couldn't find that.");
      if (status === 409) throw new CalendlyError("conflict", "Calendly already has that.");
      if (status >= 500 || status === 429)
        throw new CalendlyError("unavailable", "LUME couldn't reach Calendly.");
      throw new CalendlyError("bad_request", `Calendly answered ${status}.`);
    }
  }

  const uuidOf = (uri: string) => uri.split("/").at(-1)!;

  async function create(
    scope: "organization" | "user",
    s: { url: string; signingKey: string; organization: string; user: string },
  ): Promise<Subscription> {
    const body = {
      url: s.url,
      events: CALENDLY_EVENTS,
      organization: s.organization,
      ...(scope === "user" ? { user: s.user } : {}),
      scope,
      signing_key: s.signingKey,
    };
    try {
      const r = await call<{ resource: { uri: string } }>("POST", "/webhook_subscriptions", body);
      return { uri: r.resource.uri, scope };
    } catch (e) {
      if (!(e instanceof CalendlyError) || e.kind !== "conflict") throw e;
      // One already at this address (a reconnect): its key isn't LUME's to know, so it goes and is made again.
      const q = new URLSearchParams({
        organization: s.organization,
        scope,
        ...(scope === "user" ? { user: s.user } : {}),
      });
      const list = await call<{ collection: { uri: string; callback_url: string }[] }>(
        "GET",
        `/webhook_subscriptions?${q.toString()}`,
      );
      for (const old of list.collection.filter((x) => x.callback_url === s.url))
        await call("DELETE", `/webhook_subscriptions/${uuidOf(old.uri)}`);
      const r = await call<{ resource: { uri: string } }>("POST", "/webhook_subscriptions", body);
      return { uri: r.resource.uri, scope };
    }
  }

  return {
    async me() {
      const r = await call<{
        resource: { uri: string; name: string; email: string; current_organization: string };
      }>("GET", "/users/me");
      return {
        uri: r.resource.uri,
        name: r.resource.name,
        email: r.resource.email,
        organization: r.resource.current_organization,
      };
    },
    async subscribe(s) {
      try {
        return await create("organization", s);
      } catch (e) {
        // Not an org admin: their own bookings only.
        if (e instanceof CalendlyError && e.kind === "forbidden") return create("user", s);
        throw e;
      }
    },
    async unsubscribe(uri) {
      await call("DELETE", `/webhook_subscriptions/${uuidOf(uri)}`);
    },
    async subscription(uri) {
      const r = await call<{ resource: { state?: string } }>("GET", `/webhook_subscriptions/${uuidOf(uri)}`);
      return { state: r.resource.state ?? "active" };
    },
  };
}
