import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { checkCalendly } from "../calendly/health";

/**
 * LUME AI on Calendly (spec 2026-11-28, option A, approved by the owner): where it would offer times, LUME AI shares
 * the business's Calendly booking link and the lead picks the time on Calendly's own page. LUME adds the exact link;
 * LUME AI never books or claims a time. With the link not working, it offers the call times, as before.
 */
let h: Harness;
let meta: MetaFake;
let cal: CalendlyFake;
type U = Awaited<ReturnType<Harness["seedUser"]>>;
let admin: U;
let goalStage: { id: string };
const licence = testLicence({ instanceId: "LUME-TEST-CAL-LINK", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const DAY = 86_400_000;
const DISC = "https://api.calendly.com/event_types/DISC";
const LINK = "https://calendly.com/maya/DISC";
const calls = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "16:00", to: "19:00" }],
  minutes: 30,
  noticeHours: 2,
  daysAhead: 14,
  how: "We'll call you on this number.",
};

const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}) =>
  (await as(admin)).inject({ method: "POST", url, payload: payload as object });
const patch = async (url: string, payload: unknown) =>
  (await as(admin)).inject({ method: "PATCH", url, payload: payload as object });
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
  bookingLink: false,
  ...o,
});
const phoneOf: Record<string, string> = {};
const writes = async (leadId: string, text: string) => {
  await deliver(
    h,
    inbound({
      from: phoneOf[leadId]!.slice(1),
      id: `wamid.${newId()}`,
      at: h.clock.now.toISOString(),
      type: "text",
      text: { body: text },
    }),
  );
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
const setCalls = async (c: unknown) =>
  expect((await patch("/api/v1/ai/profile", { standing: { calls: c } })).statusCode).toBe(200);
let seen = 0;
/** The reply read just made: never an earlier one standing in for it (a held send makes none). */
const lastRead = () => {
  const reads = provider.calls.slice(seen).filter((c) => c.input.includes('"task":"autopilot_reply"'));
  expect(reads.length, "a new reply read").toBeGreaterThan(0);
  seen = provider.calls.length;
  return reads.at(-1)!;
};
let n = 10;
const inRun = async (name: string, permissions = AUTOPILOT_PRESETS.hands_off) => {
  const phone = `+9198764000${n++}`;
  const id = await h.seedLead({ ownerId: admin.id, name, phone });
  phoneOf[id] = phone;
  const r = await post("/api/v1/autopilot/runs", {
    leadIds: [id],
    goal: { kind: "stage", stageId: goalStage.id },
    speakerId: null,
    permissions,
    followUpDays: [2, 5],
    dailyCap: null,
  });
  expect(r.statusCode, r.body).toBe(201);
  await sendNext();
  return { id, run: r.json().run.id as string };
};
const shares = (message = "Happy to talk! Pick a time that suits you on the link below.") =>
  provider.script("autopilot_reply", [reply({ message, bookingLink: true })]);

beforeAll(async () => {
  meta = await startMetaFake();
  cal = await startCalendlyFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    calendlyEndpoint: cal.url,
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  h.clock.now = new Date("2026-11-30T09:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
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
  expect((await post("/api/v1/integrations/calendly", { token: cal.token })).statusCode).toBe(200);
});
afterAll(async () => {
  await h.close();
  await meta.close();
  await cal.close();
});
beforeEach(async () => {
  cal.links = [{ uri: DISC, name: "Discovery call", duration: 30, owner: "Maya Kapoor" }];
  expect((await patch("/api/v1/integrations/calendly", { bookWith: DISC })).statusCode).toBe(200);
  await setCalls({ ...calls, via: "calendly" });
  // A fresh Monday for each case, inside working hours (a weekend would hold the sends).
  h.clock.advance(7 * DAY);
  expect((await post("/api/v1/licence/check")).statusCode).toBe(200);
});

describe("Settings → LUME AI", () => {
  it("shows the booking link LUME AI would share, and Book meetings works with it and no call times", async () => {
    await setCalls({ ...calls, windows: [], via: "calendly" });
    const v = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai/profile" })).json();
    expect(v.bookingLink).toEqual({ name: "Discovery call", ready: true });
    expect(v.available.book_meetings).toEqual({ ok: true });
  });

  it("no booking link chosen in Calendly's settings: said, and Book meetings needs call times again", async () => {
    expect((await patch("/api/v1/integrations/calendly", { bookWith: null })).statusCode).toBe(200);
    await setCalls({ ...calls, windows: [], via: "calendly" });
    const v = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai/profile" })).json();
    expect(v.bookingLink).toMatchObject({ ready: false });
    expect(v.bookingLink.why).toMatch(/booking link/);
    expect(v.available.book_meetings.ok).toBe(false);
  });
});

describe("in the conversation", () => {
  it("LUME AI shares the link: LUME adds the exact address under its words, and offers no times", async () => {
    const { id } = await inRun("Asha Rao");
    await writes(id, "Can we have a call this week?");
    shares();
    await sendNext();
    expect(sentTo(id).at(-1)).toBe(`Happy to talk! Pick a time that suits you on the link below.\n\n${LINK}`);
    const read = lastRead();
    expect(read.instructions).toContain("LUME adds the business's booking link under your message");
    expect(JSON.parse(read.input).callTimes).toBeUndefined();
  });

  it("Book meetings on Ask me: the reply with the link waits for a tap", async () => {
    const { id, run } = await inRun("Ravi Menon", { ...AUTOPILOT_PRESETS.hands_off, book_meetings: "ask" });
    await writes(id, "When can we talk?");
    shares();
    await sendNext();
    expect(await stateOf(run, id)).toMatchObject({ state: "needs_you" });
    expect(sentTo(id)).toEqual(["template"]);
  });

  it("the link stopped working between the reply and the send: a person gets the lead, nothing half-sent", async () => {
    const { id, run } = await inRun("Neha Joshi");
    await writes(id, "Can we talk?");
    shares();
    await tick();
    cal.links = [];
    await checkCalendly({ pool: h.pool, keyring: h.keyring, endpoint: cal.url, wait: async () => undefined });
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await stateOf(run, id)).toMatchObject({
      state: "needs_you",
      card: { headline: "LUME's Calendly link stopped working, so LUME AI didn't send its reply." },
    });
  });

  it("the link not working (gone from Calendly): LUME AI offers the call times instead", async () => {
    cal.links = [];
    await checkCalendly({ pool: h.pool, keyring: h.keyring, endpoint: cal.url, wait: async () => undefined });
    const { id } = await inRun("Kiran Das");
    await writes(id, "Can we talk?");
    provider.script("autopilot_reply", [reply({ message: "Happy to! What time suits you?" })]);
    await sendNext();
    const read = lastRead();
    expect(read.instructions).not.toContain("booking link");
    expect(JSON.parse(read.input).callTimes).toBeDefined();
    // Back in Calendly: the link again.
    cal.links = [{ uri: DISC, name: "Discovery call", duration: 30, owner: "Maya Kapoor" }];
    await checkCalendly({ pool: h.pool, keyring: h.keyring, endpoint: cal.url, wait: async () => undefined });
    await writes(id, "Tomorrow maybe?");
    shares();
    await sendNext();
    expect(sentTo(id).at(-1)).toContain(LINK);
  });

  it("chosen as times: the call times, exactly as before", async () => {
    await setCalls({ ...calls, via: "times" });
    const { id } = await inRun("Dev Patel");
    await writes(id, "Can we talk?");
    provider.script("autopilot_reply", [reply({ message: "Happy to! What time suits you?" })]);
    await sendNext();
    const read = lastRead();
    expect(read.instructions).not.toContain("booking link");
    expect(JSON.parse(read.input).callTimes).toBeDefined();
  });

  it("a lead who has already booked: LUME AI is told, and asked not to send the link again", async () => {
    const { id } = await inRun("Sara Khan");
    // As the admin, the lead's owner, seeing every lead (meetings are under row-level security).
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
        [admin.id],
      );
      await c.query(
        `INSERT INTO meetings (id, lead_id, owner_id, title, starts_at, ends_at, status, source, external_id, matched_by)
         VALUES ($1, $2, $3, 'Discovery call', $4, $5, 'scheduled', 'calendly', 'https://api.calendly.com/x', 'calendly')`,
        [
          newId(),
          id,
          admin.id,
          new Date(h.clock.now.getTime() + 2 * DAY),
          new Date(h.clock.now.getTime() + 2 * DAY + 1_800_000),
        ],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await writes(id, "Thanks! Anything I should prepare?");
    provider.script("autopilot_reply", [reply({ message: "Nothing at all, just come as you are." })]);
    await sendNext();
    expect(lastRead().instructions).toMatch(/already booked a call for .+: don't send the link again/);
  });
});
