import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { AT_MAX_HEADLINE } from "./at-max";
import { LEADS_HELD } from "./engine";

/**
 * Autopilot and AI leads (owner's spec 2026-11-12 §1, §3, §4): starting on a lead counts it; with the month's AI leads
 * used up a new lead waits (until the 1st or a top-up) while leads already counted keep going; a lead's 20th counted
 * read hands it to a person and tells its rep. Time only moves forward here (the licence keeps the newest answer).
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
/** The run's goal: a stage, so a reply is talked to (a "reply" goal would be reached by it). */
let goalStage: string;
const licence = testLicence({ instanceId: "LUME-TEST-AI-LEADS", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
/** This month on the business's clock (Dubai, the harness's), as the licence counts it. */
const monthNow = () => new Date(h.clock.now.getTime() + 4 * 60 * MIN).toISOString().slice(0, 7);
const plan = (aiLeadsMonthly: number | null, topUp = 0) =>
  licence.setPlan({
    places: null,
    modules: ALL_MODULES,
    aiReadsHourly: null,
    aiLeadsMonthly,
    aiLeadTopUps: topUp ? [{ month: monthNow(), leads: topUp }] : [],
  });

const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}, u: U = admin) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const checkIn = () => post("/api/v1/licence/check");
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
const sendNext = async () => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
};
/** Minutes pass: every lead the pacing lets go is written, revealed and sent. */
const drain = async () => {
  for (let i = 0; i < 6; i++) {
    await tick(MIN);
    await tick(10 * S);
  }
  await h.runWhatsAppSend();
};
const used = async () => (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai" })).json().leads;
const phoneOf: Record<string, string> = {};
let n = 0;
const lead = async (name: string, owner: U = rep) => {
  const phone = `+9198770${String(++n).padStart(5, "0")}`;
  const id = await h.seedLead({ ownerId: owner.id, name, phone });
  phoneOf[id] = phone;
  return id;
};
const startRun = async (
  leadIds: string[],
  permissions: Record<string, string> = AUTOPILOT_PRESETS.hands_off,
) => {
  const r = await post("/api/v1/autopilot/runs", {
    leadIds,
    goal: { kind: "stage", stageId: goalStage },
    speakerId: null,
    permissions,
    followUpDays: [2, 5],
    dailyCap: null,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().run.id as string;
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
const stateOf = async (run: string, leadId: string) =>
  (
    await h.queryAll<{
      state: string;
      reason: string | null;
      next_at: Date | null;
      card: { headline: string; quote: string | null } | null;
    }>("SELECT state, reason, next_at, card FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2", [
      run,
      leadId,
    ])
  )[0]!;
const reply = (o: Partial<AutopilotReply> = {}): AutopilotReply => ({
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
/** Who was told about this lead (notices go once the request has committed, so they're waited for). */
const toldEventually = async (leadId: string, k: number) => {
  await vi.waitFor(async () => expect(await toldTo(leadId)).toHaveLength(k), { timeout: 3000 });
  return toldTo(leadId);
};
/** A lead's counted reads this month so far, as if LUME AI had already done them (it's counted, with `k` reads). */
const alreadyRead = async (leadId: string, k: number) => {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    await c.query(
      "INSERT INTO ai_lead_months (month, lead_id, counted_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [monthNow(), leadId, h.clock.now],
    );
    for (let i = 0; i < k; i++)
      await c.query(
        `INSERT INTO ai_reads (id, lead_id, user_id, task, provider, model, status, created_at, lead_month)
         VALUES (gen_random_uuid(), $1, $2, 'next_step', 'fake', 'fake-1', 'ok', $3, $4)`,
        [leadId, admin.id, h.clock.now, monthNow()],
      );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
/** Who heard about this lead, from each person's own bell (notices are each person's own). */
const toldTo = async (leadId: string) => {
  const out: { user_id: string; title: string }[] = [];
  for (const u of [admin, rep]) {
    const items = (await (await as(u)).inject({ method: "GET", url: "/api/v1/notifications" })).json()
      .items as {
      kind: string;
      title: string;
      leadId: string | null;
    }[];
    for (const i of items)
      if (i.leadId === leadId && i.kind === "autopilot_ready") out.push({ user_id: u.id, title: i.title });
  }
  return out;
};

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  h.clock.now = new Date("2026-09-21T09:00:00Z"); // Monday, 13:00 in Dubai
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
    ],
    totp: false,
  });
  const { pipelineId } = await h.config();
  goalStage = (
    await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!.id;
  plan(100);
  await checkIn();
  await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
let week = 0;
beforeEach(async () => {
  // Each test on a later Monday, 13:00 in Dubai, in a month of its own (time only moves forward).
  h.clock.now = new Date(new Date("2026-10-05T09:00:00Z").getTime() + week++ * 35 * DAY);
  await h.queryAll("DELETE FROM autopilot_runs");
  meta.sent.length = 0;
});

describe("Autopilot counts AI leads", () => {
  it("starting on a lead counts it, even with one template and no read to choose it", async () => {
    plan(100);
    await checkIn();
    const before = (await used()).used;
    const one = await lead("Meera Iyer");
    await startRun([one]);
    await sendNext();
    expect(meta.sent).toHaveLength(1);
    expect((await used()).used).toBe(before + 1);
  });

  it("T4: all used: a new lead waits for the 1st, a counted one keeps talking, and a top-up starts the next", async () => {
    plan(1);
    await checkIn();
    const meera = await lead("Meera Iyer");
    const rohan = await lead("Rohan Gupta");
    const run = await startRun([meera, rohan]);
    await drain();
    expect(meta.sent).toHaveLength(1);
    const held = await stateOf(run, rohan);
    expect(held).toMatchObject({ state: "up_next", reason: LEADS_HELD });
    // Until the 1st on the business's clock (00:00 in Dubai).
    expect(new Date(held.next_at!.getTime() + 4 * 60 * MIN).toISOString().slice(8, 19)).toBe("01T00:00:00");
    // The counted lead keeps full AI: it writes, LUME AI replies.
    provider.script("autopilot_reply", [reply({ message: "Yes, we can help with that." })]);
    await writes(meera, "Do you do kitchens?");
    await sendNext();
    expect((await stateOf(run, meera)).state).toBe("talking");
    // A top-up: the held lead starts at the next look, without waiting for the 1st.
    plan(1, 100);
    await checkIn();
    await drain();
    expect((await stateOf(run, rohan)).state).toBe("sent");
    expect((await stateOf(run, rohan)).reason).toBeNull();
  });

  it("T5: its 20th counted read goes, then the lead is waiting for you and its rep is told, once", async () => {
    plan(100);
    await checkIn();
    const asha = await lead("Asha Kulkarni");
    // Leads aren't handed to reps in this run: its rep hears anyway, as the lead is theirs from here.
    const run = await startRun([asha], { ...AUTOPILOT_PRESETS.hands_off, hand_to_rep: "never" });
    await sendNext();
    await alreadyRead(asha, 19);
    provider.script("autopilot_reply", [reply({ message: "Sure, Thursday works." })]);
    await writes(asha, "Can we meet Thursday?");
    await sendNext();
    // The 20th was sent first, then the lead went to a person.
    expect(meta.sent.map((m) => (m.body as { type: string }).type)).toEqual(["template", "text"]);
    const s = await stateOf(run, asha);
    expect(s).toMatchObject({ state: "needs_you", card: { headline: AT_MAX_HEADLINE, quote: null } });
    expect(s.reason).toMatch(/^LUME AI gave this lead its 20 replies and suggestions for this month\./);
    const told = await toldEventually(asha, 2);
    expect(told.map((t) => t.user_id).sort()).toEqual([admin.id, rep.id].sort());
    expect(told[0]!.title).toBe(
      "Asha needs you: LUME AI's 20 replies and suggestions for this month are used",
    );
    // Nothing more from LUME AI for it: a follow-up day passes, nothing goes.
    await tick(3 * DAY);
    await sendNext();
    expect(meta.sent).toHaveLength(2);
    expect(await toldTo(asha)).toHaveLength(2);
  });

  it("T5: a catch-up that's the lead's 20th hands an Autopilot lead to a person too", async () => {
    plan(100);
    await checkIn();
    const kabir = await lead("Kabir Shah");
    const run = await startRun([kabir]);
    await sendNext();
    expect((await stateOf(run, kabir)).state).toBe("sent");
    await alreadyRead(kabir, 19);
    const r = await post(`/api/v1/leads/${kabir}/ai/catch-up`, {}, rep);
    expect(r.json()).toHaveProperty("read");
    expect(await stateOf(run, kabir)).toMatchObject({
      state: "needs_you",
      card: { headline: AT_MAX_HEADLINE },
    });
    // The 21st is refused, with when LUME AI is back for it.
    const again = await post(`/api/v1/leads/${kabir}/ai/catch-up`, {}, rep);
    expect(again.json()).toMatchObject({ unavailable: "lead_cap" });
    expect(await toldEventually(kabir, 2)).toHaveLength(2);
  });

  it("the estimate says how many of this month's AI leads are left", async () => {
    plan(10);
    await checkIn();
    await alreadyRead(await lead("Pooja Rao"), 1);
    const r = await post("/api/v1/autopilot/estimate", {
      leadIds: [await lead("Ravi Iyer"), await lead("Lata Menon")],
      goal: { kind: "stage", stageId: goalStage },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    });
    expect(r.json()).toMatchObject({ firstMessages: 2, aiLeadsLeft: 9, monthShare: null });
  });

  it("with no AI leads left, a run doesn't start, and says why (Base too)", async () => {
    plan(1);
    await checkIn();
    const counted = await lead("Neha Joshi");
    await alreadyRead(counted, 1);
    const r = await post("/api/v1/autopilot/runs", {
      leadIds: [await lead("Tara Singh")],
      goal: { kind: "stage", stageId: goalStage },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "AI_LEADS",
      message:
        "This month's AI leads are used up, so LUME AI can't start on new leads. Ask for a top-up from LUME AI's ring, or start again on the 1st.",
    });
    plan(0);
    await checkIn();
    const base = await post("/api/v1/autopilot/runs", {
      leadIds: [await lead("Dev Patel")],
      goal: { kind: "stage", stageId: goalStage },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    });
    expect(base.json().error.message).toBe("Your plan has no AI leads, so LUME AI can't start on leads.");
  });

  it("a lead already at its 20 isn't started by a new run: it goes straight to a person", async () => {
    plan(100);
    await checkIn();
    const isha = await lead("Isha Menon");
    await alreadyRead(isha, 20);
    const run = await startRun([isha]);
    await sendNext();
    expect(meta.sent).toHaveLength(0);
    expect(await stateOf(run, isha)).toMatchObject({
      state: "needs_you",
      card: { headline: AT_MAX_HEADLINE },
    });
  });

  it("a held lead starts by itself on the 1st, and no longer says it's waiting", async () => {
    plan(1);
    await checkIn();
    const meera = await lead("Meera Iyer");
    const rohan = await lead("Rohan Gupta");
    const run = await startRun([meera, rohan]);
    await drain();
    const held = await stateOf(run, rohan);
    expect(held.reason).toBe(LEADS_HELD);
    // 10:00 on the month's first weekday in Dubai: the new month's AI leads, inside working hours.
    h.clock.now = new Date(held.next_at!.getTime() + 10 * 60 * MIN);
    while ([0, 6].includes(new Date(h.clock.now.getTime() + 4 * 60 * MIN).getUTCDay())) h.clock.advance(DAY);
    await checkIn();
    await drain();
    expect(await stateOf(run, rohan)).toMatchObject({ state: "sent", reason: null });
  });

  it("a lead from last month who writes when this month's are used up waits for room; the hour's wait doesn't say so", async () => {
    // Room to start this month (the test before used this month's only one); one AI lead in the next.
    plan(100);
    await checkIn();
    const sara = await lead("Sara Khan");
    const run = await startRun([sara]);
    await drain();
    expect((await stateOf(run, sara)).state).toBe("sent");
    // Next month: another lead took this month's only AI lead, then Sara writes.
    h.clock.now = new Date(Date.parse(`${monthNow()}-01T00:00:00+04:00`) + 32 * DAY);
    h.clock.now = new Date(Date.parse(`${monthNow()}-01T10:00:00+04:00`));
    // The month's first weekday, 10:00 in Dubai: a reply waits for working hours, and this is about AI leads.
    while ([0, 6].includes(new Date(h.clock.now.getTime() + 4 * 60 * MIN).getUTCDay())) h.clock.advance(DAY);
    plan(1);
    await checkIn();
    await alreadyRead(await lead("Omar Ali"), 1);
    provider.script("autopilot_reply", [reply({ message: "Hello again." })]);
    await writes(sara, "Are you still offering the visit?");
    await drain();
    expect(await stateOf(run, sara)).toMatchObject({ state: "replied", reason: LEADS_HELD });
    // A top-up: she gets her reply.
    plan(1, 100);
    await checkIn();
    await drain();
    expect(await stateOf(run, sara)).toMatchObject({ state: "talking", reason: null });

    // The hour's safety net: she waits, but not for AI leads.
    licence.setPlan({
      places: null,
      modules: ALL_MODULES,
      aiReadsHourly: 1,
      aiLeadsMonthly: 100,
      aiLeadTopUps: [],
    });
    await checkIn();
    provider.script("autopilot_reply", [reply({ message: "Sure." })]);
    await writes(sara, "Great, Thursday?");
    await drain();
    const waiting = await stateOf(run, sara);
    expect(waiting.state).toBe("replied");
    expect(waiting.reason).not.toBe(LEADS_HELD);
  });
});
