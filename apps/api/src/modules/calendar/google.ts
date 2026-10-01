import { GoogleError, googleCaller, grantTokens, type TokenSource } from "../sheets/google";

/** One of the account's calendars (5A): the primary one's id is the account's address. */
export type CalendarListEntry = { id: string; name: string; primary: boolean };

/** A calendar event as LUME reads it: only the rules see it until one keeps it (spec §2.2). */
export type CalendarEventRead = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  title: string;
  /** null only for a cancelled event read incrementally (Google sends its id and status alone). */
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  organizer: string | null;
  attendees: string[];
  link: string | null;
  location: string | null;
};

/** Google's 410: the sync token expired; the calendar must be read in full again (spec §2.3). */
export class SyncTokenGone extends Error {
  constructor() {
    super("The calendar's sync token expired.");
    this.name = "SyncTokenGone";
  }
}

/** What LUME asks of Google Calendar: read-only, its calendars and their events. */
export type GoogleCalendar = {
  calendarList(): Promise<CalendarListEntry[]>;
  /** Every event in the window, or every change since the token; with the token to read on from. */
  events(
    calendarId: string,
    from: { syncToken: string } | { timeMin: Date; timeMax: Date },
  ): Promise<{ events: CalendarEventRead[]; nextSyncToken: string }>;
};

/** A calendar of 40 pages of 250 is 10,000 events in the window: beyond that LUME stops rather than loop. */
const MAX_PAGES = 40;

type GTime = { dateTime?: string; date?: string };
type GEvent = {
  id: string;
  status?: string;
  summary?: string;
  start?: GTime;
  end?: GTime;
  organizer?: { email?: string };
  attendees?: { email?: string }[];
  hangoutLink?: string;
  location?: string;
};

const at = (t: GTime | undefined): Date | null => {
  const v = t?.dateTime ?? (t?.date ? `${t.date}T00:00:00Z` : null);
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
};
const read = (e: GEvent): CalendarEventRead => ({
  id: e.id,
  status: e.status === "cancelled" || e.status === "tentative" ? e.status : "confirmed",
  title: e.summary ?? "",
  startsAt: at(e.start),
  endsAt: at(e.end),
  allDay: !e.start?.dateTime && !!e.start?.date,
  organizer: e.organizer?.email ?? null,
  attendees: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
  link: e.hangoutLink ?? null,
  location: e.location ?? null,
});

export function createGoogleCalendar(o: {
  tokens: TokenSource;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): GoogleCalendar {
  const base = `${o.endpoint ?? "https://www.googleapis.com"}/calendar/v3`;
  const call = googleCaller({
    tokens: o.tokens,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  const enc = encodeURIComponent;

  /** Every page of a list, following nextPageToken; the last page's own fields come back too. */
  async function pages<T, L>(first: string): Promise<{ items: T[]; last: L }> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      const j = await call<{ items?: T[]; nextPageToken?: string } & L>(
        pageToken ? `${first}&pageToken=${enc(pageToken)}` : first,
      );
      items.push(...(j.items ?? []));
      if (!j.nextPageToken) return { items, last: j };
      pageToken = j.nextPageToken;
    }
    throw new GoogleError("bad_request", "This calendar has more events than LUME reads at once.");
  }

  return {
    async calendarList() {
      const { items } = await pages<{ id: string; summary?: string; primary?: boolean }, object>(
        `${base}/users/me/calendarList?maxResults=250&minAccessRole=reader`,
      );
      return items.map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: !!c.primary }));
    },
    async events(calendarId, from) {
      const q =
        "syncToken" in from
          ? `syncToken=${enc(from.syncToken)}`
          : `timeMin=${enc(from.timeMin.toISOString())}&timeMax=${enc(from.timeMax.toISOString())}`;
      try {
        const { items, last } = await pages<GEvent, { nextSyncToken?: string }>(
          `${base}/calendars/${enc(calendarId)}/events?singleEvents=true&maxResults=250&${q}`,
        );
        if (!last.nextSyncToken) throw new GoogleError("bad_request", "Google gave no sync token.");
        return { events: items.map(read), nextSyncToken: last.nextSyncToken };
      } catch (e) {
        if (e instanceof GoogleError && e.kind === "gone") throw new SyncTokenGone();
        throw e;
      }
    },
  };
}

/** A calendar connection's client; null when Connect with Google isn't configured here. */
export const calendarClientFor =
  (oauth: { relayUrl: string; relayToken: string } | null | undefined, endpoint?: string) =>
  (grant: string): GoogleCalendar | null =>
    oauth
      ? createGoogleCalendar({ tokens: grantTokens(oauth, grant), ...(endpoint ? { endpoint } : {}) })
      : null;
