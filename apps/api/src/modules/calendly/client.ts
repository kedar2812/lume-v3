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
    /** Calendly's own words (a 400's), for LUME to recognise; never shown or logged with the token. */
    readonly said = "",
  ) {
    super(message);
    this.name = "CalendlyError";
  }
}

/** One of the account's scheduling links (Calendly's event type), as Settings lists them. */
export type CalendlyLink = {
  uri: string;
  name: string;
  /** Minutes. */
  duration: number;
  schedulingUrl: string;
  /** Whose link it is (Calendly's profile name), when Calendly says. */
  owner: string | null;
  /** round_robin, collective… when it's a team's; null for one person's. */
  pooling: string | null;
  paid: boolean;
  locations: { kind: string; location: string | null }[];
  questions: { name: string; required: boolean; enabled: boolean }[];
};
/** A booking LUME made (Calendly's Scheduling API): the invitee, and the event it's on. */
export type CalendlyBooked = { uri: string; event: string };

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
  /** The account's active scheduling links: the organization's for an admin's token, else the person's own. */
  links(o: { scope: "organization" | "user"; organization: string; user: string }): Promise<CalendlyLink[]>;
  /** A link's free start times between two instants (Calendly answers a week at a time). */
  freeTimes(link: string, from: Date, to: Date): Promise<Date[]>;
  /**
   * Books a time on a link for an invitee (POST /invitees): Calendly sends its own invite and reminders. Never retried
   * on its own: a retry could book twice.
   */
  book(o: {
    link: string;
    at: Date;
    name: string;
    email: string;
    timezone: string;
    location?: { kind: string; location?: string };
    answers?: { question: string; answer: string; position: number }[];
  }): Promise<CalendlyBooked>;
  /** Cancels a booking LUME made (its scheduled event), when LUME couldn't keep it. */
  cancel(event: string, reason: string): Promise<void>;
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

  async function call<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
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
      if (retry && (status >= 500 || status === 429) && attempt < RETRIES.length) {
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
      throw new CalendlyError("bad_request", `Calendly answered ${status}.`, said);
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
    async links(w) {
      type Item = {
        uri: string;
        name: string | null;
        duration: number;
        scheduling_url: string;
        active: boolean;
        pooling_type?: string | null;
        is_paid?: boolean;
        profile?: { name?: string | null } | null;
        locations?: { kind: string; location?: string | null }[] | null;
        custom_questions?: { name: string; required?: boolean; enabled?: boolean }[] | null;
      };
      const out: CalendlyLink[] = [];
      let page: string | null = null;
      // At most ten pages of a hundred: an account with more is far past what one LUME shows.
      for (let i = 0; i < 10; i++) {
        const q: URLSearchParams = new URLSearchParams({
          ...(w.scope === "organization" ? { organization: w.organization } : { user: w.user }),
          active: "true",
          count: "100",
          ...(page ? { page_token: page } : {}),
        });
        type Page = { collection: Item[]; pagination?: { next_page_token?: string | null } };
        const r: Page = await call<Page>("GET", `/event_types?${q.toString()}`);
        for (const x of r.collection)
          if (x.active)
            out.push({
              uri: x.uri,
              name: x.name ?? "Untitled",
              duration: x.duration,
              schedulingUrl: x.scheduling_url,
              owner: x.profile?.name ?? null,
              pooling: x.pooling_type ?? null,
              paid: !!x.is_paid,
              locations: (x.locations ?? []).map((l) => ({ kind: l.kind, location: l.location ?? null })),
              questions: (x.custom_questions ?? []).map((c) => ({
                name: c.name,
                required: !!c.required,
                enabled: c.enabled !== false,
              })),
            });
        page = r.pagination?.next_page_token ?? null;
        if (!page) break;
      }
      return out;
    },
    async freeTimes(link, from, to) {
      const WEEK = 7 * 24 * 3_600_000;
      const out: Date[] = [];
      for (let a = from.getTime(); a < to.getTime(); a += WEEK) {
        const q = new URLSearchParams({
          event_type: link,
          start_time: new Date(a).toISOString(),
          end_time: new Date(Math.min(a + WEEK, to.getTime())).toISOString(),
        });
        const r = await call<{ collection: { status: string; start_time: string }[] }>(
          "GET",
          `/event_type_available_times?${q.toString()}`,
        );
        for (const t of r.collection) if (t.status === "available") out.push(new Date(t.start_time));
      }
      return out;
    },
    async book(b) {
      const r = await call<{ resource: { uri: string; event: string } }>(
        "POST",
        "/invitees",
        {
          event_type: b.link,
          start_time: b.at.toISOString(),
          invitee: { name: b.name, email: b.email, timezone: b.timezone },
          ...(b.location ? { location: b.location } : {}),
          ...(b.answers?.length ? { questions_and_answers: b.answers } : {}),
        },
        false,
      );
      return { uri: r.resource.uri, event: r.resource.event };
    },
    async cancel(event, reason) {
      await call("POST", `/scheduled_events/${uuidOf(event)}/cancellation`, { reason }, false);
    },
  };
}
