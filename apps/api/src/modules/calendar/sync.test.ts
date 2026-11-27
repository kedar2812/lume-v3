import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { ALL_GRANTS, newId, seal, sign } from "@lume/core";
import { adminUrl } from "@lume/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { grantTokens } from "../sheets/google";
import { createGoogleCalendar, eventIdOf } from "./google";
import { askOutcomes } from "../meetings/outcomes";
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
  await h.ownerPool.query(
    `UPDATE settings SET integrations = '{"googleCalendar":{"enabled":true}}' WHERE id = 1`,
  );
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
    last_failed_at: Date | null;
  }>(
    "SELECT status, failures, last_error, next_sync_at, last_synced_at, last_failed_at FROM calendar_connections WHERE id = $1",
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
    // Nor any personal event's time, in any time column (and the kept meetings' times are there).
    const times = await su<{ t: string; c: string }>(
      `SELECT table_schema || '.' || quote_ident(table_name) AS t, quote_ident(column_name) AS c
         FROM information_schema.columns
        WHERE table_schema IN ('public', 'pgboss') AND data_type = 'timestamp with time zone'`,
    );
    const at$ = (when: string[]) =>
      su<{ hit: string }>(
        times
          .map(
            ({ t, c }) => `(SELECT '${t}.${c}' AS hit FROM ${t} WHERE ${c} = ANY($1::timestamptz[]) LIMIT 1)`,
          )
          .join(" UNION ALL "),
        [when],
      );
    const personal = Array.from({ length: 50 }, (_, i) => [at(24 + i), at(25 + i)]).flat();
    expect(await at$(personal)).toEqual([]);
    expect(await at$([at(2)])).toContainEqual({ hit: "public.meetings.starts_at" });
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

  // Only leads' calls (owner 2026-11-27: "lume has to fetch data relevant to leads only, nothing else related to
  // current clients or personal details").
  it("a title word or a calendar never brings in an event without a lead: nothing of it is kept", async () => {
    h.fake!.putEvent(ME, {
      id: "tw-demo",
      title: "Product demo with Private-Person",
      start: at(8),
      end: at(9),
      attendees: [ME, "someone@personal.test"],
    });
    await setRules({ attendeeIsLead: true, titleWords: ["demo"], calendarIds: [ME] });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "tw-demo")).toBeUndefined();
    expect(await su("SELECT 1 FROM meetings WHERE title ~* 'private-person'")).toEqual([]);
    await setRules({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
  });

  it("title words narrow the leads' events: one without any of them stays out", async () => {
    const lead = await h.seedLead({ ownerId: maya.id, email: "narrow@leads.test" });
    await setRules({ attendeeIsLead: true, titleWords: ["discovery"], calendarIds: [] });
    h.fake!.putEvent(ME, {
      id: "nw-in",
      title: "Discovery call",
      start: at(4),
      end: at(5),
      attendees: ["narrow@leads.test"],
    });
    h.fake!.putEvent(ME, {
      id: "nw-out",
      title: "Weekly session",
      start: at(6),
      end: at(7),
      attendees: ["narrow@leads.test"],
    });
    await sync(mayaConn);
    const m = (await meetings(maya.id)).filter((x) => x.external_id.startsWith("nw-"));
    expect(m.map((x) => [x.external_id, x.lead_id])).toEqual([["nw-in", lead]]);
    await setRules({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
  });

  it("a customer's sessions stay out once they're won; a call from before the win stays theirs", async () => {
    const lead = await h.seedLead({ ownerId: maya.id, email: "client@customers.test" });
    h.fake!.putEvent(ME, {
      id: "cu-before",
      title: "Sales call",
      start: at(-48),
      end: at(-47),
      attendees: ["client@customers.test"],
    });
    h.fake!.putEvent(ME, {
      id: "cu-after",
      title: "Weekly session",
      start: at(30),
      end: at(31),
      attendees: ["client@customers.test"],
    });
    await sync(mayaConn);
    expect((await meetings(maya.id)).filter((x) => x.external_id.startsWith("cu-"))).toHaveLength(2);
    // Won a day ago: the next full read takes the session to come out, and keeps the call before.
    await su("UPDATE leads SET won_at = $2 WHERE id = $1", [lead, at(-24)]);
    h.clock.advance(25 * HOUR);
    await sync(mayaConn);
    const m = (await meetings(maya.id)).filter((x) => x.external_id.startsWith("cu-"));
    expect(m.map((x) => [x.external_id, x.lead_id])).toEqual([["cu-before", lead]]);
  });

  it("the same email on a customer and on a newer open lead: the event is the open lead's", async () => {
    const won = await h.seedLead({ ownerId: maya.id, email: "again@customers.test" });
    await su("UPDATE leads SET won_at = $2 WHERE id = $1", [won, at(-240)]);
    const open = await h.seedLead({ ownerId: maya.id, email: "again@customers.test" });
    h.fake!.putEvent(ME, {
      id: "ag-1",
      title: "New project call",
      start: at(12),
      end: at(13),
      attendees: ["again@customers.test"],
    });
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "ag-1")).toMatchObject({ lead_id: open });
  });

  it("a meeting a person linked to a lead by hand stays theirs through the next full read, whoever is invited", async () => {
    await h.seedLead({ ownerId: maya.id, email: "invited@leads.test" });
    const other = await h.seedLead({ ownerId: maya.id, name: "Phone-only lead" });
    h.fake!.putEvent(ME, {
      id: "ln-1",
      title: "Call",
      start: at(14),
      end: at(15),
      attendees: ["invited@leads.test"],
    });
    await sync(mayaConn);
    // As Link to a lead leaves it (a person's link), and the invite changed since.
    await su("UPDATE meetings SET lead_id = $1, matched_by = 'person' WHERE external_id = 'ln-1'", [other]);
    h.fake!.putEvent(ME, {
      id: "ln-1",
      title: "Call",
      start: at(14),
      end: at(15),
      attendees: ["someone@else.test"],
    });
    h.clock.advance(25 * HOUR);
    await sync(mayaConn);
    expect((await meetings(maya.id)).find((x) => x.external_id === "ln-1")).toMatchObject({
      lead_id: other,
      matched_by: "person",
    });
  });

  it("linking a meeting by hand marks it as the person's", async () => {
    const lead = await h.seedLead({ ownerId: maya.id, name: "Linked by hand" });
    const id = newId();
    await su(
      `INSERT INTO meetings (id, owner_id, connection_id, source, external_id, matched_by, title, starts_at, ends_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'google', 'hand-1', 'title', 'Call', now() + interval '1 day', now() + interval '25 hours', now(), now())`,
      [id, maya.id, mayaConn],
    );
    const r = await (
      await h.signIn(maya)
    ).inject({
      method: "PATCH",
      url: `/api/v1/meetings/${id}`,
      payload: { leadId: lead },
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await su<{ matched_by: string }>("SELECT matched_by FROM meetings WHERE id = $1", [id]))[0]!
        .matched_by,
    ).toBe("person");
  });

  it("migration 0139: Google's unlinked meetings with nothing recorded go; an outcome or a lead keeps one", async () => {
    const lead = await h.seedLead({ ownerId: maya.id, email: "kept@leads.test" });
    const ins = (id: string, leadId: string | null, status: string, outcome: boolean) =>
      su(
        `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, matched_by, title, starts_at, ends_at,
                               status, outcome_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'google', $5, 'title', 'Old', now(), now() + interval '1 hour', $6, $7, now(), now())`,
        [newId(), leadId, maya.id, mayaConn, id, status, outcome ? new Date() : null],
      );
    await ins("mg-junk", null, "scheduled", false);
    await ins("mg-cancelled", null, "cancelled", false);
    await ins("mg-logged", null, "completed", true);
    await ins("mg-lead", lead, "scheduled", false);
    await ins("mg-hand", lead, "scheduled", false);
    const [hand] = await su<{ id: string }>("SELECT id FROM meetings WHERE external_id = 'mg-hand'");
    await su(
      "INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('meeting.attached', 'meeting', $1)",
      [hand!.id],
    );
    const { readFile } = await import("node:fs/promises");
    const file = new URL(
      "../../../../../packages/db/migrations/0139_calendar_leads_only.sql",
      import.meta.url,
    );
    await setRules({ attendeeIsLead: true, titleWords: ["Call"], calendarIds: [ME] });
    // As migrations run: the tables' owner, whom row-level security binds (review 2026-11-28: as the superuser the
    // test passed while the real thing changed nothing).
    await h.ownerPool.query(await readFile(file, "utf8"));
    const left = await su<{ external_id: string }>(
      "SELECT external_id FROM meetings WHERE external_id LIKE 'mg-%' ORDER BY external_id",
    );
    expect(left.map((x) => x.external_id)).toEqual(["mg-hand", "mg-lead", "mg-logged"]);
    const marked = await su<{ external_id: string; matched_by: string }>(
      "SELECT external_id, matched_by FROM meetings WHERE external_id IN ('mg-hand', 'mg-lead') ORDER BY external_id",
    );
    expect(marked.map((x) => x.matched_by)).toEqual(["person", "title"]);
    const [c] = await swept<{ calendars: { fullAt?: string }[]; next_sync_at: Date }>(
      "SELECT calendars, next_sync_at FROM calendar_connections WHERE id = $1",
      [mayaConn],
    );
    expect(c!.calendars.every((x) => x.fullAt === undefined)).toBe(true);
    // Narrowing saved under the old meaning is cleared; row-level security is FORCEd again.
    const [rules] = await su<{ r: unknown }>("SELECT calendar->'rules' AS r FROM settings WHERE id = 1");
    expect(rules!.r).toEqual({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
    const forced = await su<{ relname: string; relforcerowsecurity: boolean }>(
      "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('meetings', 'calendar_connections') ORDER BY relname",
    );
    expect(forced.every((x) => x.relforcerowsecurity)).toBe(true);
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
    // When it failed, so Refresh can tell its own sync failed (5D review) rather than wait it out.
    expect(c.last_failed_at?.getTime()).toBe(h.clock.now.getTime());
    expect(c.next_sync_at.getTime()).toBeGreaterThan(h.clock.now.getTime() + 5 * 60_000);
    expect(await meetings(maya.id)).toEqual(before);
    expect(await sync(mayaConn)).toBe("synced");
    expect((await connRow(mayaConn)).failures).toBe(0);
  });

  it("a sync says how far it has got, for the Refresh card's bar, and clears it when done (owner, 2026-10-05)", async () => {
    const base = deps();
    const seen: unknown[] = [];
    const me = await h.signIn(maya); // earlier tests moved the clock on: a fresh session
    const progress = async () =>
      (await me.inject({ method: "GET", url: "/api/v1/calendar/connection" })).json().syncProgress;
    const watched = {
      ...base,
      clientFor: (grant: string) => {
        const real = base.clientFor(grant)!;
        return {
          ...real,
          // Mid-read: what the Refresh card would see right now.
          events: async (...a: Parameters<typeof real.events>) => {
            seen.push(await progress());
            return real.events(...a);
          },
        };
      },
    };
    expect(await runCalendarSync(watched, mayaConn)).toBe("synced");
    expect(seen[0]).toMatchObject({ stage: "reading", done: 0, total: 1 });
    expect(await progress()).toBeNull();
    const [row] = await swept<{ p: unknown }>(
      "SELECT sync_progress AS p FROM calendar_connections WHERE id = $1",
      [mayaConn],
    );
    expect(row!.p).toBeNull();
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

/** Writes as one person, seeing every lead (as LUME's sync does). */
async function asPerson(userId: string, sql: string, params: unknown[] = []) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      userId,
    ]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
const meetingOf = async (externalId: string) =>
  (
    await su<{
      id: string;
      status: string;
      calendar_id: string;
      outcome_at: Date | null;
      outcome_asked_at: Date | null;
      outcome_task_id: string | null;
    }>(
      "SELECT id, status, calendar_id, outcome_at, outcome_asked_at, outcome_task_id FROM meetings WHERE owner_id = $1 AND external_id = $2",
      [maya.id, externalId],
    )
  )[0];
const taskStatus = async (id: string) =>
  (await su<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [id]))[0]?.status;
const choose = async (calendars: string[]) => {
  const r = await mayaC.inject({
    method: "PATCH",
    url: "/api/v1/calendar/connection",
    payload: { calendars },
  });
  expect(r.statusCode).toBe(200);
};

describe("the final review's fixes (5A)", () => {
  it("a meeting with a lead that moves later is asked about again: its old outcome and Log outcome are set aside", async () => {
    mayaC = await h.signIn(maya);
    await h.seedLead({ ownerId: maya.id, email: "mover@leads.test" });
    for (const id of ["fx-asked", "fx-recorded"])
      h.fake!.putEvent(ME, { id, title: id, start: at(-3), end: at(-2), attendees: ["mover@leads.test"] });
    await sync(mayaConn);
    await askOutcomes({ app: h.app, pool: h.pool }, h.clock.now);
    const asked = (await meetingOf("fx-asked"))!.outcome_task_id!;
    const recordedTask = (await meetingOf("fx-recorded"))!.outcome_task_id!;
    expect(await taskStatus(asked)).toBe("open");
    await asPerson(
      maya.id,
      "UPDATE meetings SET status = 'rescheduled', outcome_at = $2, outcome_note = 'Moving it' WHERE owner_id = $3 AND external_id = $1",
      ["fx-recorded", h.clock.now, maya.id],
    );
    for (const id of ["fx-asked", "fx-recorded"])
      h.fake!.putEvent(ME, { id, title: id, start: at(48), end: at(49), attendees: ["mover@leads.test"] });
    await sync(mayaConn);
    for (const id of ["fx-asked", "fx-recorded"])
      expect(await meetingOf(id)).toMatchObject({
        status: "scheduled",
        outcome_at: null,
        outcome_asked_at: null,
        outcome_task_id: null,
      });
    expect(await taskStatus(asked)).toBe("cancelled");
    expect(await taskStatus(recordedTask)).toBe("cancelled");
  });

  it("a meeting that's gone or cancelled closes its Log outcome; a cancellation never overwrites a recorded outcome", async () => {
    await h.seedLead({ ownerId: maya.id, email: "closer@leads.test" });
    for (const id of ["fx-drop", "fx-cancel", "fx-done"])
      h.fake!.putEvent(ME, { id, title: id, start: at(-3), end: at(-2), attendees: ["closer@leads.test"] });
    await sync(mayaConn);
    await askOutcomes({ app: h.app, pool: h.pool }, h.clock.now);
    const dropTask = (await meetingOf("fx-drop"))!.outcome_task_id!;
    const cancelTask = (await meetingOf("fx-cancel"))!.outcome_task_id!;
    await asPerson(
      maya.id,
      "UPDATE meetings SET status = 'completed', outcome_at = $2 WHERE owner_id = $3 AND external_id = $1",
      ["fx-done", h.clock.now, maya.id],
    );
    h.fake!.putEvent(ME, {
      id: "fx-drop",
      title: "fx-drop",
      start: at(-3),
      end: at(-2),
      attendees: ["someone@else.test"],
    });
    h.fake!.cancelEvent(ME, "fx-cancel");
    h.fake!.cancelEvent(ME, "fx-done");
    await sync(mayaConn);
    expect(await meetingOf("fx-drop")).toBeUndefined();
    expect(await meetingOf("fx-cancel")).toMatchObject({ status: "cancelled" });
    expect(await meetingOf("fx-done")).toMatchObject({ status: "completed" });
    expect(await taskStatus(dropTask)).toBe("cancelled");
    expect(await taskStatus(cancelTask)).toBe("cancelled");
  });

  it("one event on two chosen calendars is one meeting, kept while either calendar keeps it", async () => {
    h.fake!.putCalendar("team2@group.test", { name: "Team two" });
    await sync(mayaConn); // lists it
    await choose([ME, "team2@group.test"]);
    await h.seedLead({ ownerId: maya.id, email: "review@leads.test" });
    const both = (title: string) => {
      for (const cal of [ME, "team2@group.test"])
        h.fake!.putEvent(cal, {
          id: "fx-both",
          title,
          start: at(30),
          end: at(31),
          attendees: [ME, "review@leads.test"],
        });
    };
    both("Pipeline review");
    await sync(mayaConn);
    const first = await meetingOf("fx-both");
    expect(first?.calendar_id).toMatch(/^(team2@group\.test|maya@business\.test)$/);
    both("Pipeline review, moved");
    await sync(mayaConn);
    expect((await meetingOf("fx-both"))?.id).toBe(first!.id);
    // A lead attending, on both calendars: un-choosing the calendar its meeting is on keeps the meeting.
    await h.seedLead({ ownerId: maya.id, email: "both@leads.test" });
    for (const cal of [ME, "team2@group.test"])
      h.fake!.putEvent(cal, {
        id: "fx-lead",
        title: "Both",
        start: at(32),
        end: at(33),
        attendees: ["both@leads.test"],
      });
    await sync(mayaConn);
    const linked = (await meetingOf("fx-lead"))!;
    await choose(linked.calendar_id === ME ? ["team2@group.test"] : [ME]);
    await sync(mayaConn);
    expect((await meetingOf("fx-lead"))?.id).toBe(linked.id);
    await choose([ME]);
    await sync(mayaConn);
  });

  it("someone no longer active, or no longer allowed to connect a calendar, isn't read: LUME disconnects them and keeps their meetings with leads", async () => {
    const ava = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Ava Away" });
    const avaConn = await connect(await h.signIn(ava), ava.id, "rt-ok-ava");
    const lead = await h.seedLead({ ownerId: ava.id, email: "avalead@leads.test" });
    h.fake!.putEvent(ME, {
      id: "fx-ava",
      title: "Ava's call",
      start: at(3),
      end: at(4),
      attendees: ["avalead@leads.test"],
    });
    await sync(avaConn);
    expect((await meetings(ava.id)).map((x) => x.lead_id)).toContain(lead);
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ava.id]);
    const calls = h.fake!.calls.length;
    expect(await sync(avaConn)).toBe("skipped");
    expect(h.fake!.calls.length).toBe(calls);
    expect(await swept("SELECT id FROM calendar_connections WHERE id = $1", [avaConn])).toEqual([]);
    expect((await meetings(ava.id)).map((x) => x.lead_id)).toContain(lead);

    const zed = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Zed Nope" });
    const zedConn = await connect(await h.signIn(zed), zed.id, "rt-ok-zed");
    await h.revokeGrant(zed.id, "calendar.connect");
    expect(await sync(zedConn)).toBe("skipped");
    expect(await swept("SELECT id FROM calendar_connections WHERE id = $1", [zedConn])).toEqual([]);
  });

  it("the person's own address, or a colleague's, being a lead's email never pulls their calendar in", async () => {
    await h.seedLead({ ownerId: maya.id, name: "Maya, as a lead", email: ME });
    await h.seedLead({ ownerId: maya.id, name: "Sam, as a lead", email: sam.email });
    h.fake!.putEvent(ME, { id: "fx-self", title: "Dentist", start: at(5), end: at(6) });
    h.fake!.putEvent(ME, { id: "fx-selfatt", title: "Gym", start: at(7), end: at(8), attendees: [ME] });
    h.fake!.putEvent(ME, {
      id: "fx-colleague",
      title: "Team lunch",
      start: at(9),
      end: at(10),
      attendees: [ME, sam.email],
    });
    await sync(mayaConn);
    for (const id of ["fx-self", "fx-selfatt", "fx-colleague"]) expect(await meetingOf(id)).toBeUndefined();
  });
});

describe("5C final review: a Google meeting's reminder follows its meeting", () => {
  it("moved at Google, its open reminder moves with it; cancelled, it closes (bug hunt 2026-11-17: it used to close, and no new one came)", async () => {
    mayaC = await h.signIn(maya);
    const lead = await h.seedLead({ ownerId: maya.id, email: "followed@leads.test" });
    for (const id of ["rem-move", "rem-cancel"])
      h.fake!.putEvent(ME, { id, title: id, start: at(30), end: at(31), attendees: ["followed@leads.test"] });
    await sync(mayaConn);
    const tasks: Record<string, string> = {};
    for (const id of ["rem-move", "rem-cancel"]) {
      const t = newId();
      tasks[id] = t;
      await h.queryAll(
        `INSERT INTO tasks (id, lead_id, assignee_id, type, title, due_at, series_id, meeting_id)
         VALUES ($1, $2, $3, 'whatsapp', 'Remind', now() + interval '1 day', $1, $4)`,
        [t, lead, maya.id, (await meetingOf(id))!.id],
      );
    }
    h.fake!.putEvent(ME, {
      id: "rem-move",
      title: "rem-move",
      start: at(40),
      end: at(41),
      attendees: ["followed@leads.test"],
    });
    h.fake!.cancelEvent(ME, "rem-cancel");
    const dueOf = async (id: string) =>
      (
        await h.queryAll<{ due_at: Date }>("SELECT due_at FROM tasks WHERE id = $1", [id])
      )[0]!.due_at.getTime();
    const before = await dueOf(tasks["rem-move"]!);
    await sync(mayaConn);
    expect(await taskStatus(tasks["rem-move"]!)).toBe("open");
    expect((await dueOf(tasks["rem-move"]!)) - before).toBe(
      new Date(at(40)).getTime() - new Date(at(30)).getTime(),
    );
    expect(await taskStatus(tasks["rem-cancel"]!)).toBe("cancelled");
  });

  it("a reminder that already went, its meeting moved later at Google: it's armed again for the new time (review 2026-11-17)", async () => {
    mayaC = await h.signIn(maya);
    const lead = await h.seedLead({ ownerId: maya.id, email: "fired@leads.test" });
    h.fake!.putEvent(ME, {
      id: "rem-fired",
      title: "rem-fired",
      start: at(1),
      end: at(2),
      attendees: ["fired@leads.test"],
    });
    await sync(mayaConn);
    const t = newId();
    const due = new Date(h.clock.now.getTime() - 5 * 60_000);
    await h.queryAll(
      `INSERT INTO tasks (id, lead_id, assignee_id, type, title, due_at, series_id, meeting_id, remind_minutes)
       VALUES ($1, $2, $3, 'whatsapp', 'Remind', $4, $1, $5, '{0}')`,
      [t, lead, maya.id, due, (await meetingOf("rem-fired"))!.id],
    );
    await h.queryAll(
      `INSERT INTO scheduled_notifications (task_id, offset_minutes, fire_at, status, fired_at)
       VALUES ($1, 0, $2, 'fired', $2)`,
      [t, due],
    );
    h.fake!.putEvent(ME, {
      id: "rem-fired",
      title: "rem-fired",
      start: at(11),
      end: at(12),
      attendees: ["fired@leads.test"],
    });
    await sync(mayaConn);
    const [sn] = await h.queryAll<{ status: string; fire_at: Date; fired_at: Date | null }>(
      "SELECT status, fire_at, fired_at FROM scheduled_notifications WHERE task_id = $1",
      [t],
    );
    expect(sn!.status).toBe("pending");
    expect(sn!.fired_at).toBeNull();
    expect(sn!.fire_at.getTime()).toBe(due.getTime() + 10 * HOUR);
  });
});

describe("Refresh hears what the sync changed (5D Task 2)", () => {
  // Their own person: earlier tests revoke Sam's grant and move Maya's calendars around.
  let rafa: SeededUser;
  let rafaC: AuthedClient;
  let rafaConn: string;
  beforeAll(async () => {
    rafa = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Rafa Lim" });
    rafaC = await h.signIn(rafa);
    rafaConn = await connect(rafaC, rafa.id, "rt-ok-rafa");
  });
  const lastSync = (id: string) =>
    swept<{
      last_sync: { at: string; added: number; moved: number; cancelled: number; changed: number } | null;
    }>("SELECT last_sync FROM calendar_connections WHERE id = $1", [id]).then((r) => r[0]!.last_sync);

  it("counts meetings added, moved, cancelled and otherwise changed; a quiet sync counts zeros at a new time", async () => {
    rafaC = await h.signIn(rafa);
    await h.seedLead({ ownerId: rafa.id, email: "counted@leads.test" });
    const cal = ME;
    // The shared fake calendar already holds other tests' meetings: a first sync takes those in.
    expect(await sync(rafaConn)).toBe("synced");
    h.clock.advance(60_000);
    // `at` follows the clock, which moves between syncs: take each time once, or every re-put event "moves".
    const [t10, t11, t20, t21] = [at(10), at(11), at(20), at(21)];
    for (const id of ["cnt-a", "cnt-b", "cnt-c"])
      h.fake!.putEvent(cal, { id, title: id, start: t10, end: t11, attendees: ["counted@leads.test"] });
    expect(await sync(rafaConn)).toBe("synced");
    const first = await lastSync(rafaConn);
    expect(first).toMatchObject({ added: 3, moved: 0, cancelled: 0, changed: 0 });
    expect(new Date(first!.at).getTime()).toBe(h.clock.now.getTime());

    h.clock.advance(60_000);
    h.fake!.putEvent(cal, {
      id: "cnt-a",
      title: "cnt-a",
      start: t20,
      end: t21,
      attendees: ["counted@leads.test"],
    });
    h.fake!.putEvent(cal, {
      id: "cnt-b",
      title: "Renamed",
      start: t10,
      end: t11,
      attendees: ["counted@leads.test"],
    });
    h.fake!.cancelEvent(cal, "cnt-c");
    expect(await sync(rafaConn)).toBe("synced");
    expect(await lastSync(rafaConn)).toMatchObject({ added: 0, moved: 1, cancelled: 1, changed: 1 });

    h.clock.advance(60_000);
    expect(await sync(rafaConn)).toBe("synced");
    const quiet = await lastSync(rafaConn);
    expect(quiet).toMatchObject({ added: 0, moved: 0, cancelled: 0, changed: 0 });
    expect(new Date(quiet!.at).getTime()).toBe(h.clock.now.getTime());
  });

  it("the connection view shows the last sync and never the grant; Refresh says from when to wait", async () => {
    const v = (await rafaC.inject({ method: "GET", url: "/api/v1/calendar/connection" })).json();
    expect(v.lastSync).toMatchObject({ added: 0, moved: 0, cancelled: 0, changed: 0 });
    expect(JSON.stringify(v)).not.toMatch(/grant|refresh|rt-ok/i);
    const r = await rafaC.inject({ method: "POST", url: "/api/v1/calendar/connection/sync" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ queued: true, since: h.clock.now.toISOString() });
  });

  it("Review Focus 3: a Refresh asked while a sync runs isn't lost — that sync leaves the connection due at once", async () => {
    // The sync started at `now`; the Refresh came a second later, while it read Google.
    const started = h.clock.now;
    // As Rafa, the way Refresh writes it: with no person set, row-level security would match no row.
    await asPerson(rafa.id, "UPDATE calendar_connections SET sync_requested_at = $2 WHERE id = $1", [
      rafaConn,
      new Date(started.getTime() + 1000),
    ]);
    expect(await sync(rafaConn)).toBe("synced");
    expect((await connRow(rafaConn)).next_sync_at.getTime()).toBe(started.getTime());
    // With no Refresh waiting, the next sync is the usual five minutes away.
    h.clock.advance(5000);
    expect(await sync(rafaConn)).toBe("synced");
    expect((await connRow(rafaConn)).next_sync_at.getTime()).toBe(h.clock.now.getTime() + 5 * 60_000);
  });
});

describe("a call LUME added to Google Calendar (spec 2026-11-03)", () => {
  /** LUME AI's booked call, as bookCall keeps it: source lume, no connection. */
  const lumeCall = async (owner: SeededUser, startsAt: string, endsAt: string) => {
    const lead = await h.seedLead({ ownerId: owner.id, name: "Asha Rao" });
    const id = newId();
    await asPerson(
      owner.id,
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at,
                             location, link, status)
       VALUES ($1::uuid, $2, $3, 'lume', $1::text, 'lume_ai', 'Call with Asha Rao', $4, $5, 'Google Meet',
               'https://meet.google.com/abc-defg-hij', 'scheduled')`,
      [id, lead, owner.id, startsAt, endsAt],
    );
    return id;
  };
  const rows = (owner: string, id: string) =>
    swept<{ source: string; status: string; starts_at: Date; ends_at: Date }>(
      `SELECT source, status, starts_at, ends_at FROM meetings
        WHERE owner_id = $1 AND (id = $2 OR external_id = $3) ORDER BY source`,
      [owner, id, eventIdOf(id)],
    );

  it("is read onto LUME's own meeting, never as a second one: moved at Google moves it, cancelled cancels it", async () => {
    // A title rule that would keep "Call with …" as a Google meeting, were it anyone else's event.
    await setRules({ attendeeIsLead: true, titleWords: ["call"], calendarIds: [] });
    const [s, e, s2, e2] = [at(5), at(5.5), at(30), at(30.5)];
    const id = await lumeCall(maya, s, e);
    const ev = {
      id: eventIdOf(id),
      title: "Call with Asha Rao",
      link: "https://meet.google.com/abc-defg-hij",
      lumeMeeting: id,
    };
    h.fake!.putEvent(ME, { ...ev, start: s, end: e });
    expect(await sync(mayaConn)).toBe("synced");
    expect(await rows(maya.id, id)).toEqual([
      { source: "lume", status: "scheduled", starts_at: new Date(s), ends_at: new Date(e) },
    ]);
    h.fake!.putEvent(ME, { ...ev, start: s2, end: e2 });
    expect(await sync(mayaConn)).toBe("synced");
    expect(await rows(maya.id, id)).toEqual([
      { source: "lume", status: "scheduled", starts_at: new Date(s2), ends_at: new Date(e2) },
    ]);
    h.fake!.cancelEvent(ME, eventIdOf(id));
    expect(await sync(mayaConn)).toBe("synced");
    expect(await rows(maya.id, id)).toEqual([
      { source: "lume", status: "cancelled", starts_at: new Date(s2), ends_at: new Date(e2) },
    ]);
  });

  it("an event naming someone else's meeting never touches it", async () => {
    const [s, e] = [at(8), at(8.5)];
    const sams = await lumeCall(sam, s, e);
    h.fake!.putEvent(ME, {
      id: eventIdOf(sams),
      title: "Call",
      start: at(40),
      end: at(40.5),
      lumeMeeting: sams,
    });
    expect(await sync(mayaConn)).toBe("synced");
    expect(await rows(sam.id, sams)).toEqual([
      { source: "lume", status: "scheduled", starts_at: new Date(s), ends_at: new Date(e) },
    ]);
  });
});

describe("LUME's own calendar, kept tidy (review 2026-11-04)", () => {
  const CALLS = "zoe-calls@group.calendar.google.com";
  let zoe: SeededUser;
  let zoeConn: string;
  beforeAll(async () => {
    zoe = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Zoe Lin" });
    h.fake!.putCalendar(CALLS, { name: "LUME calls", appCreated: true });
    // A grant that may change LUME's own calendar (calendar.app.created), reading it like a chosen calendar.
    zoeConn = await connect(await h.signIn(zoe), zoe.id, "rt-write-zoe");
    await asPerson(
      zoe.id,
      `UPDATE calendar_connections SET adds_events = true, calls_calendar_id = $2,
              calendars = (SELECT jsonb_agg(CASE WHEN c->>'id' = $2 THEN c || '{"chosen": true}' ELSE c END)
                             FROM jsonb_array_elements(calendars) c)
        WHERE id = $1`,
      [zoeConn, CALLS],
    );
  });
  const call = async (startsAt: string) => {
    const lead = await h.seedLead({ ownerId: zoe.id, name: "Asha Rao" });
    const id = newId();
    await asPerson(
      zoe.id,
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at,
                             location, link, status)
       VALUES ($1::uuid, $2, $3, 'lume', $1::text, 'lume_ai', 'Call with Asha Rao', $4, $5, 'Google Meet',
               'https://meet.google.com/abc-defg-hij', 'scheduled')`,
      [id, lead, zoe.id, startsAt, new Date(Date.parse(startsAt) + 30 * 60_000).toISOString()],
    );
    return id;
  };
  const statusOf = async (id: string) =>
    (await swept<{ status: string }>("SELECT status FROM meetings WHERE id = $1", [id]))[0]?.status;

  it("an event LUME made whose booking never kept (rolled back, or a crash) is taken out of Google", async () => {
    const ghost = newId();
    h.fake!.putEvent(CALLS, {
      id: eventIdOf(ghost),
      title: "Call with Asha Rao",
      start: at(6),
      end: at(6.5),
      lumeMeeting: ghost,
    });
    expect(await sync(zoeConn)).toBe("synced");
    expect(h.fake!.removed).toContainEqual({ calendarId: CALLS, id: eventIdOf(ghost) });
  });

  it("never while one of the speaker's bookings is under way: its meeting isn't kept yet", async () => {
    const busy = newId();
    h.fake!.putEvent(CALLS, {
      id: eventIdOf(busy),
      title: "Call",
      start: at(7),
      end: at(7.5),
      lumeMeeting: busy,
    });
    // A booking holds the speaker's calls lock (meetings/book.ts) until its transaction ends.
    const held = await h.ownerPool.connect();
    try {
      await held.query("SELECT pg_advisory_lock(hashtext('lume_calls'), hashtext($1))", [zoe.id]);
      expect(await sync(zoeConn)).toBe("synced");
    } finally {
      await held.query("SELECT pg_advisory_unlock(hashtext('lume_calls'), hashtext($1))", [zoe.id]);
      held.release();
    }
    expect(h.fake!.removed.map((r) => r.id)).not.toContain(eventIdOf(busy));
  });

  it("a call deleted in Google Calendar, seen by a full read only by its absence, is cancelled in LUME", async () => {
    const id = await call(at(9));
    h.fake!.putEvent(CALLS, {
      id: eventIdOf(id),
      title: "Call with Asha Rao",
      start: at(9),
      end: at(9.5),
      lumeMeeting: id,
    });
    expect(await sync(zoeConn)).toBe("synced");
    expect(await statusOf(id)).toBe("scheduled");
    h.fake!.cancelEvent(CALLS, eventIdOf(id));
    // The sync token expired: Google leaves deleted events out of the full read that follows.
    h.fake!.expireSyncTokens();
    expect(await sync(zoeConn)).toBe("synced");
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("a call of LUME's made without a Meet link has no event, and a full read leaves it alone", async () => {
    const id = await call(at(11));
    await asPerson(zoe.id, "UPDATE meetings SET link = NULL WHERE id = $1", [id]);
    h.fake!.expireSyncTokens();
    expect(await sync(zoeConn)).toBe("synced");
    expect(await statusOf(id)).toBe("scheduled");
  });
});
