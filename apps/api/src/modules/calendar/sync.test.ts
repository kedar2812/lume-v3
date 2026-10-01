import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { ALL_GRANTS, seal, sign } from "@lume/core";
import { adminUrl } from "@lume/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { grantTokens } from "../sheets/google";
import { createGoogleCalendar } from "./google";
import { dueConnections, runCalendarSync } from "./sync";

const RELAY_TOKEN = "q".repeat(40);
const ME = "maya@business.test";
const HOUR = 3_600_000;
let h: Harness;
let relay: http.Server;
let maya: SeededUser;
let sam: SeededUser;
let mayaC: AuthedClient;
let samC: AuthedClient;
let admin: SeededUser;
let mayaConn: string;
let samConn: string;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  relay = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "cs",
      pickerKey: "pk",
      appId: "1",
      secret: "s".repeat(40),
      instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
      googleTokenUrl: `${h.fake!.url}/token`,
    }),
  );
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  admin = await h.seedUser({ owner: true, totp: true });
  maya = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  sam = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Sam Reid" });
  mayaC = await h.signIn(maya);
  samC = await h.signIn(sam);
  h.fake!.putCalendar(ME, { name: ME, primary: true });
  mayaConn = await connect(mayaC, maya.id, "rt-ok-maya");
  samConn = await connect(samC, sam.id, "rt-ok-sam");
});
afterAll(async () => {
  relay.close();
  await h.close();
});

async function connect(c: AuthedClient, userId: string, refreshToken: string): Promise<string> {
  const { url } = (await c.inject({ method: "POST", url: "/api/v1/calendar/connect" })).json();
  const p = seal(RELAY_TOKEN, {
    nonce: new URL(url).searchParams.get("n")!,
    refreshToken,
    kind: "calendar",
    exp: Date.now() + 60_000,
  });
  const r = await c.inject({
    method: "POST",
    url: "/api/v1/calendar/complete",
    payload: { p, s: sign(RELAY_TOKEN, p) },
  });
  expect(r.statusCode).toBe(200);
  const [row] = await swept<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id = $1", [
    userId,
  ]);
  return row!.id;
}

const deps = () => ({
  pool: h.pool,
  keyring: h.keyring,
  // Google's retries without the real 1-2-4 s waits.
  clientFor: (grant: string) =>
    createGoogleCalendar({
      tokens: grantTokens({ relayUrl: currentRelay(), relayToken: RELAY_TOKEN }, grant),
      endpoint: h.fake!.url,
      sleep: async () => undefined,
    }),
  now: () => h.clock.now,
});
const currentRelay = () => `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
const sync = (id: string) => runCalendarSync(deps(), id);

/** Reads past row-level security altogether (the test database's superuser). */
async function su<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  const u = new URL(adminUrl());
  u.pathname = new URL(h.url("lume_owner")).pathname;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as R[];
  } finally {
    await c.end();
  }
}

/** Reads as LUME's sweep: every person's rows, never a write. */
async function swept<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('lume.lead_scope', 'all', true), set_config('lume.calendar_sweep', 'on', true)",
    );
    const r = (await c.query(sql, params)).rows as R[];
    await c.query("COMMIT");
    return r;
  } finally {
    c.release();
  }
}
const meetings = (owner: string) =>
  swept<{
    external_id: string;
    lead_id: string | null;
    title: string;
    status: string;
    starts_at: Date;
    matched_by: string;
  }>(
    "SELECT external_id, lead_id, title, status, starts_at, matched_by FROM meetings WHERE owner_id = $1 ORDER BY external_id",
    [owner],
  );
const connRow = (id: string) =>
  swept<{
    status: string;
    failures: number;
    last_error: string | null;
    next_sync_at: Date;
    last_synced_at: Date | null;
  }>(
    "SELECT status, failures, last_error, next_sync_at, last_synced_at FROM calendar_connections WHERE id = $1",
    [id],
  ).then((r) => r[0]!);
const at = (hoursFromNow: number) => new Date(h.clock.now.getTime() + hoursFromNow * HOUR).toISOString();
const setRules = (rules: unknown) =>
  h.ownerPool.query("UPDATE settings SET calendar = jsonb_build_object('rules', $1::jsonb) WHERE id = 1", [
    JSON.stringify(rules),
  ]);

beforeEach(async () => {
  await setRules({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
});

describe("the calendar sync (5A Task 5)", () => {
  it("50 personal events and 5 with leads: exactly 5 meetings, and no table anywhere holds a personal event", async () => {
    const leads: string[] = [];
    for (let i = 0; i < 5; i++)
      leads.push(await h.seedLead({ ownerId: maya.id, name: `Client ${i}`, email: `Client${i}@Leads.test` }));
    for (let i = 0; i < 50; i++)
      h.fake!.putEvent(ME, {
        id: `personal-${i}`,
        title: `Secret-Personal-${i} dentist`,
        start: at(24 + i),
        end: at(25 + i),
        attendees: [ME, `friend${i}@personal.test`],
        location: `Hidden-Place-${i}`,
      });
    for (let i = 0; i < 5; i++)
      h.fake!.putEvent(ME, {
        id: `lead-${i}`,
        title: `Discovery call ${i}`,
        start: at(2 + i),
        end: at(3 + i),
        attendees: [ME, `client${i}@leads.test`],
        link: `https://meet.example/${i}`,
      });
    expect(await sync(mayaConn)).toBe("synced");
    const m = await meetings(maya.id);
    expect(m.map((x) => [x.external_id, x.lead_id, x.matched_by])).toEqual(
      [0, 1, 2, 3, 4].map((i) => [`lead-${i}`, leads[i], "attendee"]),
    );
    // Every text-like column of every table, read past row-level security.
    const cols = await su<{ t: string; c: string }>(
      `SELECT table_schema || '.' || quote_ident(table_name) AS t, quote_ident(column_name) AS c
         FROM information_schema.columns
        WHERE table_schema IN ('public', 'pgboss')
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'USER-DEFINED', 'ARRAY')`,
    );
    expect(cols.length).toBeGreaterThan(50);
    // One round trip: every column asked at once.
    const scan = (pattern: string) =>
      su<{ hit: string }>(
        cols
          .map(({ t, c }) => `(SELECT '${t}.${c}' AS hit FROM ${t} WHERE ${c}::text ~* $1 LIMIT 1)`)
          .join(" UNION ALL "),
        [pattern],
      );
    expect(await scan("(secret-personal|personal[.]test|hidden-place|personal-[0-9])")).toEqual([]);
    // …and the scan does find what was kept: the lead meetings' titles.
    expect(await scan("discovery call [0-4]")).toContainEqual({ hit: "public.meetings.title" });
  }, 30_000);

  it("an event moved, renamed, cancelled, or no longer with a lead updates or removes its meeting", async () => {
    const lead = await h.seedLead({ ownerId: maya.id, email: "moving@leads.test" });
    for (const id of ["mv-move", "mv-cancel", "mv-drop"])
      h.fake!.putEvent(ME, { id, title: id, start: at(5), end: at(6), attendees: ["moving@leads.test"] });
    await sync(mayaConn);
    expect((await meetings(maya.id)).filter((x) => x.external_id.startsWith("mv-"))).toHaveLength(3);
    h.fake!.putEvent(ME, {
      id: "mv-move",
      title: "Moved call",
      start: at(30),
      end: at(31),
      attendees: ["moving@leads.test"],
    });
    h.fake!.cancelEvent(ME, "mv-cancel");
    h.fake!.putEvent(ME, {
      id: "mv-drop",
      title: "mv-drop",
      start: at(5),
      end: at(6),
      attendees: ["someone@else.test"],
    });
    await sync(mayaConn);
    const mv = (await meetings(maya.id)).filter((x) => x.external_id.startsWith("mv-"));
    expect(mv.map((x) => [x.external_id, x.title, x.status, x.lead_id])).toEqual([
      ["mv-cancel", "mv-cancel", "cancelled", lead],
      ["mv-move", "Moved call", "scheduled", lead],
    ]);
    expect(mv[1]!.starts_at.toISOString()).toBe(at(30));
  });

  it("the admin's rules: a title word keeps an unlinked meeting; switched off, it goes at the next full read", async () => {
    h.fake!.putEvent(ME, { id: "tw-demo", title: "Product demo", start: at(8), end: at(9), attendees: [ME] });
    await setRules({ attendeeIsLead: true, titleWords: ["demo"], calendarIds: [] });
    await sync(mayaConn); // incremental: the event is new since the last read
    expect((await meetings(maya.id)).find((x) => x.external_id === "tw-demo")).toMatchObject({
      lead_id: null,
      matched_by: "title",
    });
    await setRules({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
    h.clock.advance(25 * HOUR); // a day on: the next read is a full one
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "tw-demo")).toBeUndefined();
  });

  it("an all-day event is never a meeting", async () => {
    await h.seedLead({ ownerId: maya.id, email: "allday@leads.test" });
    h.fake!.putEvent(ME, {
      id: "ad-1",
      title: "Site visit",
      start: "2026-09-23",
      end: "2026-09-24",
      attendees: ["allday@leads.test"],
    });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "ad-1")).toBeUndefined();
  });

  it("a lead whose email arrives later is matched at the next full read", async () => {
    h.fake!.putEvent(ME, {
      id: "late-1",
      title: "Intro",
      start: at(10),
      end: at(11),
      attendees: ["late@leads.test"],
    });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "late-1")).toBeUndefined();
    const lead = await h.seedLead({ ownerId: maya.id, email: "late@leads.test" });
    await sync(mayaConn); // incremental, nothing changed at Google: not yet
    expect((await meetings(maya.id)).find((x) => x.external_id === "late-1")).toBeUndefined();
    h.clock.advance(25 * HOUR); // a day on: the next read is a full one
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "late-1")).toMatchObject({
      lead_id: lead,
    });
  });

  it("an expired sync token reads the calendar in full again, and the meetings stand", async () => {
    const before = await meetings(maya.id);
    h.fake!.expireSyncTokens();
    expect(await sync(mayaConn)).toBe("synced");
    expect(await meetings(maya.id)).toEqual(before);
    expect((await connRow(mayaConn)).failures).toBe(0);
  });

  it("Google busy: the connection backs off and keeps its meetings", async () => {
    const before = await meetings(maya.id);
    h.fake!.fail(503, 8);
    expect(await sync(mayaConn)).toBe("failed");
    h.fake!.fail(503, 0);
    const c = await connRow(mayaConn);
    expect(c).toMatchObject({ status: "active", failures: 1, last_error: "Couldn't reach Google." });
    expect(c.next_sync_at.getTime()).toBeGreaterThan(h.clock.now.getTime() + 5 * 60_000);
    expect(await meetings(maya.id)).toEqual(before);
    expect(await sync(mayaConn)).toBe("synced");
    expect((await connRow(mayaConn)).failures).toBe(0);
  });

  it("two syncs of one connection at once make one", async () => {
    const results = await Promise.all([sync(mayaConn), sync(mayaConn)]);
    expect(results.sort()).toEqual(["busy", "synced"]);
  });

  it("a calendar gone from the account takes its meetings; a new one is listed, not chosen", async () => {
    mayaC = await h.signIn(maya); // the clock has moved on two days: a fresh session
    h.fake!.putCalendar("gone@group.test", { name: "Old team" });
    await h.seedLead({ ownerId: maya.id, email: "teamlead@leads.test" });
    h.fake!.putEvent("gone@group.test", {
      id: "gone-1",
      title: "Team call",
      start: at(4),
      end: at(5),
      attendees: ["teamlead@leads.test"],
    });
    await sync(mayaConn);
    await mayaC.inject({
      method: "PATCH",
      url: "/api/v1/calendar/connection",
      payload: { calendars: [ME, "gone@group.test"] },
    });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "gone-1")).toBeDefined();
    h.fake!.removeCalendar("gone@group.test");
    h.fake!.putCalendar("new@group.test", { name: "New team" });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "gone-1")).toBeUndefined();
    const view = (await mayaC.inject({ method: "GET", url: "/api/v1/calendar/connection" })).json();
    expect(view.calendars.map((c: { id: string; chosen: boolean }) => [c.id, c.chosen])).toEqual([
      [ME, true],
      ["new@group.test", false],
    ]);
  });

  it("a grant Google refuses marks only that connection, tells its person and the admins once, and keeps its meetings", async () => {
    const samLead = await h.seedLead({ ownerId: sam.id, email: "samlead@leads.test" });
    h.fake!.putEvent(ME, {
      id: "sam-1",
      title: "Sam's call",
      start: at(3),
      end: at(4),
      attendees: ["samlead@leads.test"],
    });
    await sync(samConn);
    expect((await meetings(sam.id)).map((x) => x.lead_id)).toContain(samLead);
    h.fake!.revokeOne("rt-ok-sam");
    expect(await sync(samConn)).toBe("needs_reconnect");
    expect(await sync(mayaConn)).toBe("synced");
    expect(await connRow(samConn)).toMatchObject({ status: "needs_reconnect" });
    expect(await connRow(mayaConn)).toMatchObject({ status: "active" });
    expect((await meetings(sam.id)).map((x) => x.lead_id)).toContain(samLead);
    expect(await sync(samConn)).toBe("skipped");
    const told = await su<{ user_id: string; title: string }>(
      "SELECT user_id, title FROM notifications WHERE kind = 'calendar_reconnect'",
    );
    // Sam once; every admin (the owner, and Maya, who manages settings) once — never Sam twice.
    expect(told.map((r) => [r.user_id, r.title]).sort()).toEqual(
      [
        [sam.id, "Your Google Calendar needs connecting again"],
        [admin.id, "Sam Reid's Google Calendar needs connecting again"],
        [maya.id, "Sam Reid's Google Calendar needs connecting again"],
      ].sort(),
    );
    // only the due, active connections are LUME's to sync
    const due = await dueConnections(h.pool, new Date(h.clock.now.getTime() + 24 * HOUR));
    expect(due).toContain(mayaConn);
    expect(due).not.toContain(samConn);
  });
});
