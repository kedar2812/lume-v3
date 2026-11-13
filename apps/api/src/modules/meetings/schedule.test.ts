import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, newId, seal, sign } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * Schedule a meeting (owner, 2026-11-13): from a lead's card or the Calendar, once the person's own Google Calendar is
 * connected and lets LUME add events. The meeting goes on their LUME calls calendar with a new Meet link, is kept on
 * the lead, and the answer says whether the link can go on WhatsApp from LUME now (inside the 24 hours) or only from
 * the phone, with the message ready.
 */
let h: Harness;
let meta: MetaFake;
let relay: http.Server;
type U = Awaited<ReturnType<Harness["seedUser"]>>;
let admin: U;
let rep: U;
let booking: string;
const ME = "owner@business.test";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}, u: U = admin) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const get = async (url: string, u: U = admin) => (await as(u)).inject({ method: "GET", url });
const asAdmin = async (sql: string, params: unknown[] = []) => {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      admin.id,
    ]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
};
const callsCalendar = () => h.fake!.createdCalendars[0]!.id;
const phoneOf: Record<string, string> = {};
let n = 10;
const lead = async (name: string, owner: U = admin) => {
  const phone = `+9198764000${n++}`;
  const id = await h.seedLead({ ownerId: owner.id, name, phone });
  phoneOf[id] = phone;
  return id;
};
const writes = async (leadId: string, text: string) => {
  const r = await deliver(
    h,
    inbound({
      from: phoneOf[leadId]!.slice(1),
      id: `wamid.${newId()}`,
      at: h.clock.now.toISOString(),
      type: "text",
      text: { body: text },
    }),
  );
  expect(r.statusCode).toBe(200);
  await h.runWhatsApp();
};
/** Tomorrow at 11:30 UTC (3:30 pm in Dubai, the harness's clock). */
const tomorrow = () =>
  new Date(Math.ceil(h.clock.now.getTime() / DAY) * DAY + DAY + 11.5 * 60 * MIN).toISOString();
const schedule = (leadId: string, over: Record<string, unknown> = {}, u: U = admin) =>
  post(
    "/api/v1/meetings/schedule",
    { leadId, title: "Call with Meera", startsAt: tomorrow(), minutes: 30, notes: "", ...over },
    u,
  );
const meetingsOf = (leadId: string) =>
  h.queryAll<{ source: string; matched_by: string; link: string | null; title: string; owner_id: string }>(
    "SELECT source, matched_by, link, title, owner_id FROM meetings WHERE lead_id = $1",
    [leadId],
  );

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    google: true,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
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
  h.clock.now = new Date("2026-09-21T09:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
      { key: "calendar.view", scope: "own" },
      { key: "calendar.connect", scope: null },
      { key: "messages.send", scope: "own" },
    ],
    totp: false,
  });
  const { pipelineId } = await h.config();
  booking = (
    await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!.id;
  await h.ownerPool.query("UPDATE pipelines SET booking_stage_id = $1 WHERE id = $2", [booking, pipelineId]);
  await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{googleCalendar}', '{"enabled":true}') WHERE id = 1`,
  );
});
afterAll(async () => {
  relay.close();
  await h.close();
  await meta.close();
});
beforeEach(() => {
  h.clock.advance(DAY);
});

/** The admin connects Google Calendar: read-only first, then letting LUME add events. */
const connect = async (write: boolean) => {
  h.fake!.putCalendar(ME, { name: ME, primary: true });
  const { url } = (await post("/api/v1/calendar/connect", { addEvents: write })).json();
  const p = seal(RELAY_TOKEN, {
    nonce: new URL(url).searchParams.get("n")!,
    refreshToken: write ? "rt-write-admin" : "rt-ok-admin",
    kind: "calendar",
    calendarWrite: write,
    exp: Date.now() + 60_000,
  });
  const done = await post("/api/v1/calendar/complete", { p, s: sign(RELAY_TOKEN, p) });
  expect(done.statusCode, done.body).toBe(200);
};

describe("whether a person can schedule a meeting", () => {
  it("not until their Google Calendar is connected and lets LUME add events; each step says what's missing", async () => {
    expect((await get("/api/v1/meetings/schedule/ready")).json()).toEqual({
      ready: false,
      why: "connect",
      message: "Connect your Google Calendar to schedule meetings with a Meet link.",
    });
    await connect(false);
    expect((await get("/api/v1/meetings/schedule/ready")).json()).toEqual({
      ready: false,
      why: "permission",
      message: "Let LUME add meetings to your Google Calendar, so it can make the Meet link.",
    });
    expect((await schedule(await lead("Meera Iyer"))).statusCode).toBe(409);
    await connect(true);
    expect((await get("/api/v1/meetings/schedule/ready")).json()).toEqual({ ready: true });
  });

  it("a connection Google stopped answering asks to connect again", async () => {
    await asAdmin("UPDATE calendar_connections SET status = 'needs_reconnect'");
    expect((await get("/api/v1/meetings/schedule/ready")).json()).toMatchObject({
      ready: false,
      why: "reconnect",
    });
    await asAdmin("UPDATE calendar_connections SET status = 'active', calls_calendar_id = $1", [
      callsCalendar(),
    ]);
  });

  it("Google Calendar switched off for the business: says an admin can switch it on", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{googleCalendar}', '{"enabled":false}') WHERE id = 1`,
    );
    expect((await get("/api/v1/meetings/schedule/ready")).json()).toMatchObject({ ready: false, why: "off" });
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{googleCalendar}', '{"enabled":true}') WHERE id = 1`,
    );
  });
});

describe("scheduling a meeting", () => {
  it("adds it to their LUME calls calendar with a Meet link, keeps it on the lead, and moves the lead to booking", async () => {
    const meera = await lead("Meera Iyer");
    const r = await schedule(meera, { notes: "Bring the floor plan." });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect(b.link).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(b.meeting).toMatchObject({
      title: "Call with Meera",
      matchedBy: "lume",
      link: b.link,
      lead: { id: meera, stageId: booking },
    });
    expect(b.message).toBe(`Hi Meera, here's the Google Meet link for our call on ${b.label}: ${b.link}`);
    const sent = h.fake!.inserted.at(-1)!;
    expect(sent.calendarId).toBe(callsCalendar());
    expect(sent.body).toMatchObject({ summary: "Call with Meera", description: "Bring the floor plan." });
    expect(await meetingsOf(meera)).toEqual([
      { source: "lume", matched_by: "lume", link: b.link, title: "Call with Meera", owner_id: admin.id },
    ]);
    const acts = await h.queryAll<{ type: string; payload: { byAi?: boolean } }>(
      "SELECT type, payload FROM activities WHERE lead_id = $1 AND type = 'meeting_booked'",
      [meera],
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]!.payload.byAi).toBe(false);
  });

  it("they haven't written in 24 hours: the link can't go from LUME, says why, and the message is ready for the phone", async () => {
    const rohan = await lead("Rohan Gupta");
    const b = (await schedule(rohan)).json();
    expect(b.whatsapp).toEqual({
      send: false,
      why: "Rohan hasn't written to you on WhatsApp yet, so WhatsApp only lets LUME send them an approved template.",
      open: true,
    });
    await writes(rohan, "Hello?");
    h.clock.advance(25 * 60 * MIN);
    expect(
      (await schedule(rohan, { startsAt: new Date(h.clock.now.getTime() + 2 * DAY).toISOString() })).json()
        .whatsapp,
    ).toEqual({
      send: false,
      why: "It's been more than 24 hours since Rohan last wrote, so WhatsApp only lets LUME send them an approved template.",
      open: true,
    });
  });

  it("they wrote inside 24 hours: the link can go from LUME's inbox now", async () => {
    const asha = await lead("Asha Kulkarni");
    await writes(asha, "Can we talk tomorrow?");
    const b = (await schedule(asha)).json();
    expect(b.whatsapp).toEqual({ send: true, why: null, open: true });
    const r = await post(`/api/v1/leads/${asha}/whatsapp/messages`, { clientKey: newId(), text: b.message });
    expect(r.statusCode).toBe(202);
  });

  it("a lead without a WhatsApp number: no WhatsApp at all, said plainly", async () => {
    const id = await h.seedLead({ ownerId: admin.id, name: "Kiran Shah" });
    expect((await schedule(id)).json().whatsapp).toEqual({
      send: false,
      why: "Kiran has no WhatsApp number in LUME.",
      open: false,
    });
  });

  it("refuses in words: a time already past, a lead they can't see, a title missing", async () => {
    const id = await lead("Dev Patel");
    const past = await schedule(id, { startsAt: new Date(h.clock.now.getTime() - 10 * MIN).toISOString() });
    expect(past.statusCode, past.body).toBe(400);
    expect(past.json().error.message).toBe("Choose a time from now on.");
    const notTheirs = await lead("Nisha Rao", admin);
    expect((await schedule(notTheirs, {}, rep)).statusCode).toBe(404);
    const untitled = await schedule(id, { title: " " });
    expect(untitled.statusCode).toBe(400);
    expect(untitled.json().error.message).toBe("Give the meeting a title.");
    expect(await meetingsOf(id)).toEqual([]);
  });

  it("Google refuses: nothing is kept, and the event doesn't stay in their calendar", async () => {
    const id = await lead("Sara Khan");
    const before = h.fake!.inserted.length;
    h.fake!.fail(500, 3);
    const r = await schedule(id);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toBe(
      "Google Calendar didn't answer just now. Nothing was scheduled. Try again.",
    );
    expect(await meetingsOf(id)).toEqual([]);
    expect(h.fake!.inserted.length).toBe(before);
  });

  it("someone without their own calendar connection can't schedule, and is told how", async () => {
    const id = await lead("Om Joshi", rep);
    const r = await schedule(id, {}, rep);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "MEETING_NOT_READY",
      message: "Connect your Google Calendar to schedule meetings with a Meet link.",
    });
  });
});
