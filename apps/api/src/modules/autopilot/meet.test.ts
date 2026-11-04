import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, seal, sign, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { eventIdOf } from "../calendar/google";

/**
 * LUME makes the Meet link (spec 2026-11-03): a call LUME AI says yes to also goes into the speaker's Google Calendar
 * with a new Meet link, and the yes carries it. Without the permission, or when Google won't, a person gets the lead
 * and nothing is sent.
 */

let h: Harness;
let meta: MetaFake;
let relay: http.Server;
type U = Awaited<ReturnType<Harness["seedUser"]>>;
let admin: U;
let goalStage: { id: string };
const licence = testLicence({ instanceId: "LUME-TEST-MEET", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
const ME = "owner@business.test";
const SPEAKER = "Maya Kapoor";
/** The calendar LUME made in the admin's account when they allowed it. */
const callsCalendar = () => h.fake!.createdCalendars[0]!.id;
const MONDAY = new Date("2026-09-21T09:00:00Z");
const calls = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "16:00", to: "19:00" }],
  minutes: 30,
  noticeHours: 2,
  daysAhead: 14,
  how: "We'll call you on this number.",
  meet: true,
};

const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}) =>
  (await as(admin)).inject({ method: "POST", url, payload: payload as object });
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
const sendNext = async () => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
};
const reply = (o: Partial<AutopilotReply>): AutopilotReply => ({
  kind: "reply",
  message: "Happy to help.",
  reason: "Replied.",
  evidence: null,
  fileIds: [],
  stageId: null,
  fields: [],
  followUp: null,
  lostReasonId: null,
  meeting: null,
  ...o,
});
const phoneOf: Record<string, string> = {};
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
const sentTo = (leadId: string) =>
  meta.sent
    .filter((m) => (m.body as { to: string }).to === phoneOf[leadId]!.slice(1))
    .map((m) => {
      const b = m.body as { type: string; text?: { body: string } };
      return b.type === "text" ? b.text!.body : b.type;
    });
const stateOf = async (run: string, leadId: string) =>
  (
    await h.queryAll<{ state: string; card: { headline: string } | null }>(
      "SELECT state, card FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2",
      [run, leadId],
    )
  )[0]!;
const meetingsOf = (leadId: string) =>
  h.queryAll<{ id: string; link: string | null; location: string | null; status: string }>(
    "SELECT id, link, location, status FROM meetings WHERE lead_id = $1",
    [leadId],
  );
/** As the admin, seeing every lead (their own calendar connection is theirs alone). */
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
const setCalls = async (c: unknown) =>
  expect(
    (
      await (
        await as(admin)
      ).inject({ method: "PATCH", url: "/api/v1/ai/profile", payload: { standing: { calls: c } } })
    ).statusCode,
  ).toBe(200);
/** Tomorrow on the business's clock (Dubai, UTC+4), as "YYYY-MM-DD". */
const tomorrow = () => new Date(h.clock.now.getTime() + 4 * 60 * MIN + DAY).toISOString().slice(0, 10);
let n = 30;
const inRun = async (name: string) => {
  const phone = `+9198765000${n++}`;
  const id = await h.seedLead({ ownerId: admin.id, name, phone });
  phoneOf[id] = phone;
  const r = await post("/api/v1/autopilot/runs", {
    leadIds: [id],
    goal: { kind: "stage", stageId: goalStage.id },
    speakerId: null,
    permissions: AUTOPILOT_PRESETS.hands_off,
    followUpDays: [2, 5],
    dailyCap: null,
  });
  expect(r.statusCode, r.body).toBe(201);
  await sendNext();
  expect(sentTo(id)).toEqual(["template"]);
  return { id, run: r.json().run.id as string };
};
/** The lead asks for 5 pm tomorrow, and LUME AI says yes to it. */
const saysYes = async (id: string, at = "17:00") => {
  await writes(id, `Can we talk tomorrow at ${at === "17:00" ? "5 pm" : "6 pm"}?`);
  provider.script("autopilot_reply", [
    reply({
      message: `Done, tomorrow at ${at === "17:00" ? "5 pm" : "6 pm"} on Google Meet.`,
      meeting: { at: `${tomorrow()}T${at}` },
    }),
  ]);
};

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    google: true,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
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
  h.clock.now = MONDAY;
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: SPEAKER });
  const { pipelineId } = await h.config();
  goalStage = (
    await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!;
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 100_000 });
  expect((await post("/api/v1/licence/check")).statusCode).toBe(200);
  await seedNumber(h, { runAs: admin.id });
  await h.ownerPool.query("UPDATE whatsapp_numbers SET quality = 'green'");
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{googleCalendar}', '{"enabled":true}') WHERE id = 1`,
  );
  // The admin lets LUME add calls to their Google Calendar: the write grant, back from Google.
  h.fake!.putCalendar(ME, { name: ME, primary: true });
  const { url } = (
    await (
      await as(admin)
    ).inject({ method: "POST", url: "/api/v1/calendar/connect", payload: { addEvents: true } })
  ).json();
  const p = seal(RELAY_TOKEN, {
    nonce: new URL(url).searchParams.get("n")!,
    refreshToken: "rt-write-admin",
    kind: "calendar",
    calendarWrite: true,
    exp: Date.now() + 60_000,
  });
  const done = await (
    await as(admin)
  ).inject({ method: "POST", url: "/api/v1/calendar/complete", payload: { p, s: sign(RELAY_TOKEN, p) } });
  expect(done.json()).toMatchObject({ connected: true, addsEvents: true });
  await setCalls(calls);
});
afterAll(async () => {
  relay.close();
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await asAdmin(
    "UPDATE calendar_connections SET adds_events = true, status = 'active', calls_calendar_id = $1",
    [callsCalendar()],
  );
  if (!h.fake!.createdCalendars.some((c) => c.id === callsCalendar()))
    throw new Error("LUME's calls calendar went missing between cases");
  await setCalls(calls);
  // A fresh Monday for each case (inside working hours, tomorrow's times empty), with the licence checked in.
  h.clock.advance(7 * DAY);
  expect((await post("/api/v1/licence/check")).statusCode).toBe(200);
});

describe("LUME makes the Meet link", () => {
  it("the call goes into the speaker's Google Calendar with a Meet link, and LUME AI's yes carries it", async () => {
    const { id, run } = await inRun("Asha Rao");
    const before = h.fake!.inserted.length;
    await saysYes(id);
    await sendNext();
    const added = h.fake!.inserted.slice(before);
    expect(added).toHaveLength(1);
    const [m] = await meetingsOf(id);
    expect(m).toMatchObject({ location: "Google Meet", status: "scheduled" });
    expect(m!.link).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(added[0]).toMatchObject({
      calendarId: callsCalendar(),
      body: {
        id: eventIdOf(m!.id),
        summary: "Call with Asha Rao",
        start: { dateTime: new Date(`${tomorrow()}T13:00:00Z`).toISOString(), timeZone: "Asia/Dubai" },
        extendedProperties: { private: { lumeMeeting: m!.id } },
      },
    });
    expect(added[0]!.body.attendees).toBeUndefined();
    expect(sentTo(id)).toEqual([
      "template",
      `Done, tomorrow at 5 pm on Google Meet.\n\nGoogle Meet: ${m!.link}`,
    ]);
    expect((await stateOf(run, id)).state).toBe("ready");
  });

  /** The speaker's own calendar can't take the call: LUME AI is told so, and books it in the business's own words. */
  const fallsBack = async (name: string) => {
    const { id, run } = await inRun(name);
    const before = h.fake!.inserted.length;
    await writes(id, "Can we talk tomorrow at 5 pm?");
    provider.script("autopilot_reply", [
      reply({ message: `Done, tomorrow at 5 pm. ${calls.how}`, meeting: { at: `${tomorrow()}T17:00` } }),
    ]);
    await sendNext();
    // Review 2026-11-04: the Meet link is the speaker's own permission, not the admin's.
    expect(provider.calls.at(-1)!.instructions).not.toContain("Google Meet");
    expect(provider.calls.at(-1)!.instructions).toContain(calls.how);
    expect(sentTo(id)).toEqual(["template", `Done, tomorrow at 5 pm. ${calls.how}`]);
    expect(await meetingsOf(id)).toEqual([
      expect.objectContaining({ link: null, location: calls.how, status: "scheduled" }),
    ]);
    expect(h.fake!.inserted.length).toBe(before);
    expect((await stateOf(run, id)).state).toBe("ready");
  };

  it("the speaker hasn't let LUME add calls: the call is booked in the business's own words, no event", async () => {
    await asAdmin("UPDATE calendar_connections SET adds_events = false");
    await fallsBack("Bilal Ahmed");
  });

  it("allowed, but with no calendar of LUME's own on record: the same, never another calendar", async () => {
    await asAdmin("UPDATE calendar_connections SET calls_calendar_id = NULL");
    await fallsBack("Ivan Petrov");
  });

  it("the speaker's calendar needs connecting again: the same", async () => {
    await asAdmin("UPDATE calendar_connections SET status = 'needs_reconnect'");
    await fallsBack("Chen Wei");
  });

  it("the permission goes between the writing and the sending: held, since the yes promised a Meet link", async () => {
    const { id, run } = await inRun("Jun Park");
    await saysYes(id);
    await tick();
    await asAdmin("UPDATE calendar_connections SET adds_events = false");
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    expect(await stateOf(run, id)).toMatchObject({
      state: "needs_you",
      card: {
        headline: `LUME couldn't make a Meet link: ${SPEAKER} hasn't let LUME add calls to their Google Calendar. Nothing was sent.`,
      },
    });
  });

  it("Google refuses: held, nothing sent, nothing booked", async () => {
    const { id, run } = await inRun("Dina Farouk");
    await saysYes(id);
    await tick();
    h.fake!.fail(400, 1);
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    expect(await stateOf(run, id)).toMatchObject({
      state: "needs_you",
      card: { headline: "LUME couldn't make a Meet link just now. Nothing was sent." },
    });
  });

  it("the reply can't go after the event was added: the booking rolls back and LUME removes the event", async () => {
    const { id, run } = await inRun("Elif Demir");
    await saysYes(id);
    await tick();
    // Asked not to be messaged between the writing and the sending: the reply is refused as it goes.
    await asAdmin("UPDATE leads SET dnc_at = now(), dnc_reason = 'Asked by phone' WHERE id = $1", [id]);
    const before = h.fake!.inserted.length;
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    const added = h.fake!.inserted.slice(before);
    expect(added).toHaveLength(1);
    expect(h.fake!.removed).toContainEqual({ calendarId: callsCalendar(), id: added[0]!.body.id });
    expect((await stateOf(run, id)).state).toBe("needs_you");
  });

  it("LUME's calendar deleted in Google Calendar: held, said so, and the permission is asked for again", async () => {
    const { id, run } = await inRun("Hana Sato");
    await saysYes(id);
    const gone = callsCalendar();
    h.fake!.removeCalendar(gone);
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    expect(await stateOf(run, id)).toMatchObject({
      state: "needs_you",
      card: {
        headline: `LUME couldn't make a Meet link: LUME can no longer add calls to the LUME calls calendar in ${SPEAKER}'s Google Calendar. Nothing was sent.`,
      },
    });
    expect(
      (await (await as(admin)).inject({ method: "GET", url: "/api/v1/calendar/connection" })).json(),
    ).toMatchObject({
      addsEvents: false,
    });
    // Put back for the cases after this one.
    h.fake!.putCalendar(gone, { name: "LUME calls" });
  });

  it("switched off: no event, and LUME AI says the business's own words, as before", async () => {
    await setCalls({ ...calls, meet: false });
    const { id } = await inRun("Farah Naz");
    const before = h.fake!.inserted.length;
    await writes(id, "Can we talk tomorrow at 6 pm?");
    provider.script("autopilot_reply", [
      reply({ message: `Done, tomorrow at 6 pm. ${calls.how}`, meeting: { at: `${tomorrow()}T18:00` } }),
    ]);
    await sendNext();
    expect(sentTo(id)).toEqual(["template", `Done, tomorrow at 6 pm. ${calls.how}`]);
    expect(h.fake!.inserted.length).toBe(before);
    expect(await meetingsOf(id)).toEqual([
      expect.objectContaining({ link: null, location: calls.how, status: "scheduled" }),
    ]);
  });

  it("what LUME AI reads says LUME adds the Meet link, only while it's on", async () => {
    const { id } = await inRun("Gita Rao");
    await writes(id, "When can we talk?");
    provider.script("autopilot_reply", [reply({ message: "Happy to talk." })]);
    await sendNext();
    expect(provider.calls.at(-1)!.instructions).toContain(
      "LUME adds the Google Meet link under your message",
    );
  });
});
