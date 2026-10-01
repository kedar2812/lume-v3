import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, instanceIdOf, seal, sign, verify } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

const RELAY_TOKEN = "k".repeat(40);
const ME = "maya@business.test";
let h: Harness;
let bare: Harness;
let me: SeededUser;
let admin: AuthedClient;
let other: AuthedClient;
let noConnect: AuthedClient;
let bareAdmin: AuthedClient;
let relay: http.Server;
let relayOrigin: string;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  bare = await createHarness({ preset: "general" });
  // The relay hands out access tokens for the grant (from the fake Google), as it does for sheets.
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
  relayOrigin = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  h.setRelayUrl(relayOrigin);
  me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(me);
  other = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  noConnect = await h.signIn(
    await h.seedUser({ grants: ALL_GRANTS.filter((g) => g.key !== "calendar.connect"), totp: true }),
  );
  bareAdmin = await bare.signIn(await bare.seedUser({ grants: ALL_GRANTS, totp: true }));
  h.fake!.putCalendar(ME, { name: ME, primary: true });
  h.fake!.putCalendar("team@group.test", { name: "Sales team" });
});
afterAll(async () => {
  relay.close();
  await h.close();
  await bare.close();
});

const call = (
  c: AuthedClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

/** Reads as LUME's sweep (every person's rows); never used to write. */
const swept = async <R>(sql: string, params: unknown[] = []) => {
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
};
/** Writes as one person, seeing every lead (as LUME's sync does). */
const asPerson = async (userId: string, sql: string, params: unknown[] = []) => {
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
};

/** Starts a connect and returns the hand-back the relay would bring home for it. */
async function handBack(
  c: AuthedClient,
  o: { kind?: "calendar" | "sheet"; exp?: number; token?: string } = {},
) {
  const { url } = (await call(c, "POST", "/api/v1/calendar/connect")).json();
  const nonce = new URL(url).searchParams.get("n")!;
  const p = seal(RELAY_TOKEN, {
    nonce,
    refreshToken: o.token ?? "rt-good",
    ...(o.kind === "sheet" ? { file: { id: "f", name: "F" } } : { kind: "calendar" }),
    exp: o.exp ?? Date.now() + 60_000,
  });
  return { p, s: sign(RELAY_TOKEN, p) };
}

describe("connecting a calendar (5A Task 3)", () => {
  it("is offered only where Connect with Google is set up", async () => {
    expect((await call(bareAdmin, "GET", "/api/v1/calendar/connection")).json()).toEqual({
      available: false,
      connected: false,
    });
    const r = await call(bareAdmin, "POST", "/api/v1/calendar/connect");
    expect([r.statusCode, r.json().error.code]).toEqual([409, "NOT_CONFIGURED"]);
  });

  it("needs calendar.connect", async () => {
    expect((await call(noConnect, "POST", "/api/v1/calendar/connect")).statusCode).toBe(403);
    expect((await call(noConnect, "GET", "/api/v1/calendar/connection")).statusCode).toBe(403);
  });

  it("start gives a relay link signed for this instance, as a calendar's", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/calendar/connect")).json();
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${relayOrigin}/start`);
    expect(u.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
    expect(u.searchParams.get("k")).toBe("calendar");
    expect(verify(RELAY_TOKEN, `${u.searchParams.get("n")}.calendar`, u.searchParams.get("s")!)).toBe(true);
    // a sheet's signature (the nonce alone) is not what's given
    expect(verify(RELAY_TOKEN, u.searchParams.get("n")!, u.searchParams.get("s")!)).toBe(false);
  });

  it("refuses a tampered, expired, or sheet's hand-back", async () => {
    const good = await handBack(admin);
    const r1 = await call(admin, "POST", "/api/v1/calendar/complete", {
      p: good.p,
      s: "x" + good.s.slice(1),
    });
    expect(r1.json().error.code).toBe("CONNECT_INVALID");
    const old = await handBack(admin, { exp: Date.now() - 1 });
    expect((await call(admin, "POST", "/api/v1/calendar/complete", old)).json().error.code).toBe(
      "CONNECT_EXPIRED",
    );
    const sheet = await handBack(admin, { kind: "sheet" });
    expect((await call(admin, "POST", "/api/v1/calendar/complete", sheet)).json().error.code).toBe(
      "CONNECT_INVALID",
    );
  });

  it("a calendar hand-back can't finish a sheet's connect", async () => {
    await call(admin, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const p = seal(RELAY_TOKEN, {
      nonce: new URL(url).searchParams.get("n")!,
      refreshToken: "rt-good",
      kind: "calendar",
      exp: Date.now() + 60_000,
    });
    expect(
      (await call(admin, "POST", "/api/v1/calendar/complete", { p, s: sign(RELAY_TOKEN, p) })).json().error
        .code,
    ).toBe("CONNECT_NOT_FOUND");
  });

  it("when Google won't list the calendars, nothing is kept", async () => {
    const back = await handBack(admin);
    h.fake!.revokeGrant();
    try {
      const r = await call(admin, "POST", "/api/v1/calendar/complete", back);
      expect([r.statusCode, r.json().error.code]).toEqual([409, "CALENDAR_NO_ACCESS"]);
    } finally {
      h.fake!.restoreGrant();
    }
    expect((await call(admin, "GET", "/api/v1/calendar/connection")).json()).toMatchObject({
      connected: false,
    });
  });

  it("complete takes a genuine hand-back once, for its person: the grant sealed to the row, the primary chosen, a first sync asked", async () => {
    const back = await handBack(admin);
    expect((await call(other, "POST", "/api/v1/calendar/complete", back)).json().error.code).toBe(
      "CONNECT_NOT_FOUND",
    );
    h.calendarQueue.length = 0;
    const done = await call(admin, "POST", "/api/v1/calendar/complete", back);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      available: true,
      connected: true,
      googleEmail: ME,
      status: "active",
      calendars: [
        { id: ME, name: ME, chosen: true },
        { id: "team@group.test", name: "Sales team", chosen: false },
      ],
    });
    expect((await call(admin, "POST", "/api/v1/calendar/complete", back)).json().error.code).toBe(
      "CONNECT_NOT_FOUND",
    );
    const [row] = await swept<{ id: string; grant_enc: Buffer; calendars: unknown }>(
      "SELECT id, grant_enc, calendars FROM calendar_connections WHERE user_id = $1",
      [me.id],
    );
    expect(h.keyring.decrypt(row!.grant_enc, `calendar-connection:${row!.id}`)).toBe("rt-good");
    expect(() => h.keyring.decrypt(row!.grant_enc, "calendar-connection:someone-else")).toThrow();
    expect(JSON.stringify(row!.calendars)).not.toContain("rt-good");
    expect(h.calendarQueue).toEqual([row!.id]);
    const audit = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'calendar.%'",
      [me.id],
    );
    expect(audit.map((a) => a.action)).toEqual(["calendar.connected"]);
    // nobody else sees it
    expect((await call(other, "GET", "/api/v1/calendar/connection")).json()).toMatchObject({
      connected: false,
    });
  });

  it("choosing calendars: only the account's own; un-choosing one takes its meetings; a sync is asked", async () => {
    const bad = await call(admin, "PATCH", "/api/v1/calendar/connection", {
      calendars: ["stranger@group.test"],
    });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, "CALENDAR_UNKNOWN"]);
    const both = await call(admin, "PATCH", "/api/v1/calendar/connection", {
      calendars: [ME, "team@group.test"],
    });
    expect(both.json().calendars.map((c: { chosen: boolean }) => c.chosen)).toEqual([true, true]);
    const [conn] = await swept<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id = $1", [
      me.id,
    ]);
    await asPerson(
      me.id,
      `INSERT INTO meetings (id, owner_id, connection_id, source, external_id, calendar_id, title, starts_at, ends_at, matched_by)
       VALUES (gen_random_uuid(), $1, $2, 'google', 'team-event', 'team@group.test', 'Demo', now(), now(), 'calendar')`,
      [me.id, conn!.id],
    );
    h.calendarQueue.length = 0;
    const one = await call(admin, "PATCH", "/api/v1/calendar/connection", { calendars: [ME] });
    expect(one.json().calendars.map((c: { chosen: boolean }) => c.chosen)).toEqual([true, false]);
    expect(await swept("SELECT id FROM meetings WHERE calendar_id = 'team@group.test'")).toEqual([]);
    expect(h.calendarQueue).toEqual([conn!.id]);
  });

  it("Sync now asks for a sync; without a connection there's nothing to sync", async () => {
    h.calendarQueue.length = 0;
    expect((await call(admin, "POST", "/api/v1/calendar/connection/sync")).statusCode).toBe(202);
    expect(h.calendarQueue).toHaveLength(1);
    const none = await call(other, "POST", "/api/v1/calendar/connection/sync");
    expect([none.statusCode, none.json().error.code]).toEqual([404, "CALENDAR_NOT_CONNECTED"]);
  });

  it("connecting again replaces the grant and keeps the calendars chosen", async () => {
    const [before] = await swept<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id = $1", [
      me.id,
    ]);
    await asPerson(
      me.id,
      "UPDATE calendar_connections SET status = 'needs_reconnect', failures = 3 WHERE id = $1",
      [before!.id],
    );
    await call(admin, "PATCH", "/api/v1/calendar/connection", { calendars: [ME, "team@group.test"] });
    const again = await call(admin, "POST", "/api/v1/calendar/complete", await handBack(admin));
    expect(again.json()).toMatchObject({ status: "active", calendars: [{ chosen: true }, { chosen: true }] });
    const [after] = await swept<{ id: string; failures: number }>(
      "SELECT id, failures FROM calendar_connections WHERE user_id = $1",
      [me.id],
    );
    expect(after).toEqual({ id: before!.id, failures: 0 });
  });

  it("disconnecting leaves no grant and no meetings, and is audited", async () => {
    const [conn] = await swept<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id = $1", [
      me.id,
    ]);
    const lead = await h.seedLead({ ownerId: me.id, email: "dana@client.test" });
    await asPerson(
      me.id,
      `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, calendar_id, title, starts_at, ends_at, matched_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'google', 'linked-event', $4, 'Call', now(), now(), 'attendee')`,
      [lead, me.id, conn!.id, ME],
    );
    const r = await call(admin, "DELETE", "/api/v1/calendar/connection");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ available: true, connected: false });
    expect(await swept("SELECT id FROM calendar_connections WHERE user_id = $1", [me.id])).toEqual([]);
    expect(await swept("SELECT id FROM meetings WHERE owner_id = $1", [me.id])).toEqual([]);
    const audit = await h.queryAll<{ action: string; diff: { meetings: number } }>(
      "SELECT action, diff FROM audit_log WHERE actor_user_id = $1 AND action = 'calendar.disconnected'",
      [me.id],
    );
    expect(audit).toEqual([{ action: "calendar.disconnected", diff: { meetings: 1 } }]);
    expect((await call(admin, "DELETE", "/api/v1/calendar/connection")).statusCode).toBe(404);
  });
});
