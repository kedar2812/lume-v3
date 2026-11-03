import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startGoogleFake, type GoogleFake } from "../../../test/google-fake";
import { GoogleError, type TokenSource } from "../sheets/google";
import { SyncTokenGone, createGoogleCalendar, meetingOfEventId, type GoogleCalendar } from "./google";

const ME = "maya@business.test";
const WINDOW = { timeMin: new Date("2026-09-01T00:00:00Z"), timeMax: new Date("2026-12-31T00:00:00Z") };
let fake: GoogleFake;
let g: GoogleCalendar;
const slept: number[] = [];

/** A grant's access tokens, as the relay hands them out (the fake's refresh token "rt-good"). */
const grantTokens = (): TokenSource => async () => {
  const r = await fetch(`${fake.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-good" }),
  });
  if (!r.ok) throw new GoogleError("access", "revoked");
  return ((await r.json()) as { access_token: string }).access_token;
};

beforeAll(async () => {
  fake = await startGoogleFake();
  g = createGoogleCalendar({
    tokens: grantTokens(),
    endpoint: fake.url,
    sleep: async (ms) => void slept.push(ms),
  });
  fake.putCalendar(ME, { name: ME, primary: true });
  fake.putCalendar("team@group.test", { name: "Sales team" });
  fake.putCalendar("holidays@group.test", { name: "Holidays" });
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.calendarPageSize = 250;
});

describe("the Google Calendar client (5A Task 4)", () => {
  it("lists the account's calendars, by id and name, and which is primary — through every page", async () => {
    fake.calendarPageSize = 2;
    expect(await g.calendarList()).toEqual([
      { id: ME, name: ME, primary: true },
      { id: "team@group.test", name: "Sales team", primary: false },
      { id: "holidays@group.test", name: "Holidays", primary: false },
    ]);
  });

  it("lists only calendars the person owns: one shared with them isn't LUME's to read", async () => {
    fake.putCalendar("boss@business.test", { name: "Boss", access: "reader" });
    try {
      expect((await g.calendarList()).map((c) => c.id)).not.toContain("boss@business.test");
      expect(fake.lastCalendarListQuery?.get("minAccessRole")).toBe("owner");
    } finally {
      fake.removeCalendar("boss@business.test");
    }
  });

  it("reads a window in full through every page, in LUME's shape, and hands back a sync token", async () => {
    fake.putCalendar("full@group.test", { name: "Full" });
    for (let i = 1; i <= 5; i++)
      fake.putEvent("full@group.test", {
        id: `e${i}`,
        title: `Call ${i}`,
        start: `2026-10-0${i}T09:00:00Z`,
        end: `2026-10-0${i}T09:30:00Z`,
        attendees: [ME, `lead${i}@client.test`],
        organizer: ME,
      });
    fake.putEvent("full@group.test", {
      id: "outside",
      title: "Long ago",
      start: "2025-01-01T09:00:00Z",
      end: "2025-01-01T10:00:00Z",
    });
    fake.putEvent("full@group.test", {
      id: "allday",
      title: "Offsite",
      start: "2026-10-09",
      end: "2026-10-10",
      location: "Studio",
      link: "https://meet.example/abc",
    });
    fake.calendarPageSize = 2;
    const r = await g.events("full@group.test", WINDOW);
    expect(r.events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "allday"]);
    expect(r.events[0]).toEqual({
      id: "e1",
      status: "confirmed",
      title: "Call 1",
      startsAt: new Date("2026-10-01T09:00:00Z"),
      endsAt: new Date("2026-10-01T09:30:00Z"),
      allDay: false,
      organizer: ME,
      attendees: [ME, "lead1@client.test"],
      link: null,
      location: null,
      lumeMeeting: null,
    });
    expect(r.events[5]).toMatchObject({
      allDay: true,
      startsAt: new Date("2026-10-09T00:00:00Z"),
      endsAt: new Date("2026-10-10T00:00:00Z"),
      location: "Studio",
      link: "https://meet.example/abc",
      attendees: [],
    });
    expect(r.nextSyncToken).toMatch(/^st-/);
  });

  it("an incremental read returns only what changed since the token, a cancelled event included", async () => {
    fake.putCalendar("inc@group.test", { name: "Inc" });
    for (const id of ["a", "b", "c"])
      fake.putEvent("inc@group.test", {
        id,
        title: id,
        start: "2026-10-05T09:00:00Z",
        end: "2026-10-05T10:00:00Z",
      });
    const first = await g.events("inc@group.test", WINDOW);
    fake.putEvent("inc@group.test", {
      id: "b",
      title: "b moved",
      start: "2026-10-06T09:00:00Z",
      end: "2026-10-06T10:00:00Z",
    });
    fake.cancelEvent("inc@group.test", "c");
    fake.putEvent("inc@group.test", {
      id: "d",
      title: "new",
      start: "2026-10-07T09:00:00Z",
      end: "2026-10-07T10:00:00Z",
    });
    const next = await g.events("inc@group.test", { syncToken: first.nextSyncToken });
    expect(next.events.map((e) => [e.id, e.status, e.title])).toEqual([
      ["b", "confirmed", "b moved"],
      ["c", "cancelled", ""],
      ["d", "confirmed", "new"],
    ]);
    const quiet = await g.events("inc@group.test", { syncToken: next.nextSyncToken });
    expect(quiet.events).toEqual([]);
    expect(quiet.nextSyncToken).toMatch(/^st-/);
  });

  it("an expired sync token is SyncTokenGone, at once (not retried)", async () => {
    fake.putCalendar("gone@group.test", { name: "Gone" });
    const first = await g.events("gone@group.test", WINDOW);
    fake.expireSyncTokens();
    slept.length = 0;
    await expect(g.events("gone@group.test", { syncToken: first.nextSyncToken })).rejects.toBeInstanceOf(
      SyncTokenGone,
    );
    expect(slept).toEqual([]);
    // a full read after it gives a token that works
    const again = await g.events("gone@group.test", WINDOW);
    await expect(g.events("gone@group.test", { syncToken: again.nextSyncToken })).resolves.toMatchObject({
      events: [],
    });
  });

  it("a calendar that's gone is not_found; Google busy is retried, then transient", async () => {
    await expect(g.events("nobody@group.test", WINDOW)).rejects.toMatchObject({ kind: "not_found" });
    fake.fail(503, 1);
    await expect(g.calendarList()).resolves.toHaveLength(3 + 3);
    fake.fail(503, 4);
    await expect(g.calendarList()).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("adding LUME AI's call to Google Calendar (spec 2026-11-03)", () => {
  const writeTokens = (): TokenSource => async () => {
    const r = await fetch(`${fake.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-write" }),
    });
    return ((await r.json()) as { access_token: string }).access_token;
  };
  const w = () => createGoogleCalendar({ tokens: writeTokens(), endpoint: fake.url, sleep: async () => {} });
  const call = (meetingId: string) => ({
    meetingId,
    title: "Call with Asha Rao",
    start: new Date("2026-11-04T10:30:00Z"),
    end: new Date("2026-11-04T11:00:00Z"),
    tz: "Asia/Kolkata",
  });
  let calls = "";
  beforeAll(async () => {
    calls = (await w().createCalendar("LUME calls", "Asia/Kolkata")).id;
  });

  it("makes LUME's own calendar in the account, named, on the business's clock; it's listed with the person's own", async () => {
    expect(fake.createdCalendars.at(-1)).toEqual({
      id: calls,
      summary: "LUME calls",
      timeZone: "Asia/Kolkata",
    });
    expect((await g.calendarList()).map((c) => c.name)).toContain("LUME calls");
    // Only the grant that may: the read-only one can't make one.
    await expect(g.createCalendar("LUME calls", "UTC")).rejects.toMatchObject({ kind: "access" });
  });

  it("adds one event to it with a new Meet link, no attendees, no Google invite, LUME's id on it; the link comes back", async () => {
    const id = "0190e0c0-0000-7000-8000-00000000a001";
    const r = await w().addCall(calls, call(id));
    expect(r.link).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(r.eventId).toBe("lume0190e0c0000070008000" + "00000000a001");
    const sent = fake.inserted.at(-1)!;
    expect(sent.calendarId).toBe(calls);
    expect(sent.body).toMatchObject({
      id: r.eventId,
      summary: "Call with Asha Rao",
      start: { dateTime: "2026-11-04T10:30:00.000Z", timeZone: "Asia/Kolkata" },
      end: { dateTime: "2026-11-04T11:00:00.000Z", timeZone: "Asia/Kolkata" },
      conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      extendedProperties: { private: { lumeMeeting: id } },
    });
    expect(sent.body.attendees).toBeUndefined();
    expect(sent.query.get("sendUpdates")).toBe("none");
    expect(sent.query.get("conferenceDataVersion")).toBe("1");
  });

  it("never on a calendar LUME didn't make, the person's primary included", async () => {
    const n = fake.inserted.length;
    await expect(w().addCall(ME, call("0190e0c0-0000-7000-8000-00000000a007"))).rejects.toMatchObject({
      kind: "access",
    });
    expect(fake.inserted.length).toBe(n);
  });

  it("asked again for the same call (a retry after a lost answer): the one event is read back, never a second", async () => {
    const id = "0190e0c0-0000-7000-8000-00000000a002";
    const first = await w().addCall(calls, call(id));
    const n = fake.inserted.length;
    const again = await w().addCall(calls, call(id));
    expect(again).toEqual(first);
    expect(fake.inserted.length).toBe(n);
  });

  it("removes an event it added; one already gone is fine", async () => {
    const id = "0190e0c0-0000-7000-8000-00000000a003";
    const { eventId } = await w().addCall(calls, call(id));
    await w().removeEvent(calls, eventId);
    expect(fake.removed.at(-1)).toEqual({ calendarId: calls, id: eventId });
    await expect(w().removeEvent(calls, eventId)).resolves.toBeUndefined();
  });

  it("a read-only grant can't add one: access, nothing added", async () => {
    const n = fake.inserted.length;
    await expect(g.addCall(calls, call("0190e0c0-0000-7000-8000-00000000a004"))).rejects.toMatchObject({
      kind: "access",
    });
    expect(fake.inserted.length).toBe(n);
  });

  it("an event LUME added is read with its meeting's id; anyone else's without", async () => {
    const id = "0190e0c0-0000-7000-8000-00000000a005";
    await w().addCall(calls, call(id));
    const { events } = await g.events(calls, WINDOW);
    expect(events.find((e) => e.id === "lume" + id.replace(/-/g, ""))?.lumeMeeting).toBe(id);
    const mine = await g.events(ME, WINDOW);
    expect(mine.events.every((e) => e.lumeMeeting === null)).toBe(true);
  });

  it("one cancelled since the last read comes as its id alone: LUME's id still names the meeting", async () => {
    const id = "0190e0c0-0000-7000-8000-00000000a006";
    const first = await g.events(calls, WINDOW);
    const { eventId } = await w().addCall(calls, call(id));
    await w().removeEvent(calls, eventId);
    const { events } = await g.events(calls, { syncToken: first.nextSyncToken });
    expect(events.find((e) => e.id === eventId)).toMatchObject({ status: "cancelled", lumeMeeting: id });
    expect(meetingOfEventId("lumenotours")).toBeNull();
    expect(meetingOfEventId("abc123")).toBeNull();
  });
});
