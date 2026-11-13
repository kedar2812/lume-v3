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
  /** The organiser and attendees other than the calendar's own person (Google marks them `self`). */
  organizer: string | null;
  attendees: string[];
  link: string | null;
  location: string | null;
  /** An event LUME added for one of its own meetings (spec 2026-11-03): that meeting's id; null for anyone else's. */
  lumeMeeting: string | null;
};

/** LUME AI's call, as LUME adds it to the speaker's Google Calendar (spec 2026-11-03). */
/** `description`: the event's notes in Google Calendar (a person's own, 2026-11-13); LUME AI's say it booked it. */
export type NewCall = { meetingId: string; title: string; start: Date; end: Date; tz: string; description?: string };
/** The event's id at Google: LUME's own, from the meeting's (base32hex allows 0-9 and a-v), so a retry finds it. */
export const eventIdOf = (meetingId: string) => `lume${meetingId.replace(/-/g, "").toLowerCase()}`;
/** The meeting an event id LUME made is for; null for any other id. */
export const meetingOfEventId = (eventId: string): string | null => {
  const m = /^lume([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(eventId);
  return m ? m.slice(1).join("-") : null;
};

/** Google's 410: the sync token expired; the calendar must be read in full again (spec §2.3). */
export class SyncTokenGone extends Error {
  constructor() {
    super("The calendar's sync token expired.");
    this.name = "SyncTokenGone";
  }
}

/** What LUME asks of Google Calendar: its calendars and their events; and, with that permission, LUME AI's calls. */
export type GoogleCalendar = {
  calendarList(): Promise<CalendarListEntry[]>;
  /**
   * Makes LUME's own calendar in the account (calendar.app.created, spec 2026-11-03): the only calendar LUME may add
   * events to. It shows in the person's Google Calendar beside their own.
   */
  createCalendar(name: string, tz: string): Promise<{ id: string }>;
  /**
   * Adds the call, with a new Google Meet link, to LUME's own calendar; asked again for the same call, reads the one
   * event back.
   */
  addCall(calendarId: string, c: NewCall): Promise<{ eventId: string; link: string | null }>;
  /** Removes an event LUME added; one already gone is fine. */
  removeEvent(calendarId: string, eventId: string): Promise<void>;
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
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; self?: boolean }[];
  hangoutLink?: string;
  location?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  extendedProperties?: { private?: { lumeMeeting?: string } };
};
/** The Meet link of an event: Google's hangoutLink, or the video entry point of its conference. */
const meetLink = (e: GEvent) =>
  e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null;

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
  organizer: e.organizer?.self ? null : (e.organizer?.email ?? null),
  attendees: (e.attendees ?? [])
    .filter((a) => !a.self)
    .map((a) => a.email ?? "")
    .filter(Boolean),
  link: e.hangoutLink ?? null,
  location: e.location ?? null,
  // A cancelled event read incrementally comes as its id and status alone: LUME's own id still says whose it is.
  lumeMeeting: e.extendedProperties?.private?.lumeMeeting ?? meetingOfEventId(e.id),
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
        // Only calendars the person owns: the grant (calendar.events.owned.readonly) reads no others.
        `${base}/users/me/calendarList?maxResults=250&minAccessRole=owner`,
      );
      return items.map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: !!c.primary }));
    },
    async createCalendar(name, tz) {
      // Never retried: a lost answer to a calendar Google made would make a second "LUME calls" (review 2026-11-04).
      const j = await call<{ id: string }>(`${base}/calendars`, {
        method: "POST",
        retry: false,
        body: {
          summary: name,
          timeZone: tz,
          description: "Calls LUME AI booked for you, with their Meet links.",
        },
      });
      return { id: j.id };
    },
    async addCall(calendarId, c) {
      const eventId = eventIdOf(c.meetingId);
      const events = `${base}/calendars/${enc(calendarId)}/events`;
      let e: GEvent;
      try {
        // No attendees and no Google invite: the lead gets the link from LUME AI, on WhatsApp.
        // One attempt: this runs inside the booking's transaction, under the speaker's lock (review 2026-11-04).
        e = await call<GEvent>(`${events}?conferenceDataVersion=1&sendUpdates=none`, {
          method: "POST",
          retry: false,
          body: {
            id: eventId,
            summary: c.title,
            description: c.description ?? "Booked by LUME AI.",
            start: { dateTime: c.start.toISOString(), timeZone: c.tz },
            end: { dateTime: c.end.toISOString(), timeZone: c.tz },
            conferenceData: {
              createRequest: { requestId: c.meetingId, conferenceSolutionKey: { type: "hangoutsMeet" } },
            },
            extendedProperties: { private: { lumeMeeting: c.meetingId } },
            reminders: { useDefault: true },
          },
        });
      } catch (err) {
        if (!(err instanceof GoogleError && err.kind === "exists")) throw err;
        e = await call<GEvent>(`${events}/${enc(eventId)}`);
      }
      return { eventId, link: meetLink(e) };
    },
    async removeEvent(calendarId, eventId) {
      try {
        await call(`${base}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=none`, {
          method: "DELETE",
        });
      } catch (err) {
        if (err instanceof GoogleError && (err.kind === "gone" || err.kind === "not_found")) return;
        throw err;
      }
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
