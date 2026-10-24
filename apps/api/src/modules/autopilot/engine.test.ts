import { ALL_GRANTS, AUTOPILOT_PRESETS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { onNumberHealth } from "../whatsapp/health";
import { endRun, pauseRun, resumeRun } from "./engine";

/**
 * The run engine (Autopilot A2, Task 6; spec 2026-10-19 §1–§3, §6): each message written, revealed, then sent as an
 * approved template, paced inside the business's hours; and nothing ever sent after Pause.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let numberId: string;
const licence = testLicence({ instanceId: "LUME-TEST-ENGINE", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;

const as = (u: U) => h.signIn(u);
const lead = (name: string, o: { owner?: string | null } = {}) =>
  h.seedLead({
    ownerId: o.owner === undefined ? admin.id : o.owner,
    name,
    phone: `+9198765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`,
  });
const start = async (leadIds: string[], u: U = admin) => {
  const r = await (
    await as(u)
  ).inject({
    method: "POST",
    url: "/api/v1/autopilot/runs",
    payload: {
      leadIds,
      goal: { kind: "reply" },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().run.id as string;
};
const leadsOf = (run: string) =>
  h.queryAll<{
    lead_id: string;
    state: string;
    draft: string | null;
    reason: string | null;
    active: boolean;
  }>("SELECT lead_id, state, draft, reason, active FROM autopilot_leads WHERE run_id = $1", [run]);
const stateOf = async (run: string, leadId: string) =>
  (await leadsOf(run)).find((l) => l.lead_id === leadId)!;
const runOf = async (run: string) =>
  (
    await h.queryAll<{ status: string; pause_reason: string | null }>(
      "SELECT status, pause_reason FROM autopilot_runs WHERE id = $1",
      [run],
    )
  )[0]!;
const outbox = () =>
  h.queryAll<{ lead_id: string; status: string; autopilot_run_id: string | null; created_at: Date }>(
    "SELECT lead_id, status, autopilot_run_id, created_at FROM whatsapp_outbox ORDER BY created_at",
  );
/** Run LUME AI until it has nothing due, then let the clock move on. */
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
const checkIn = async () => (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
const dubai = (iso: string) => new Date(`${iso}+04:00`);
const DAY = 24 * 60 * MIN;
// Time only moves forward: a licence check-in never takes a token older than the one it holds. Each test starts on the
// next Monday, 13:00 in Dubai (inside working hours).
let week = 0;
let monday = dubai("2026-09-21T13:00:00");
/** This month on the business's clock (Dubai), as the licence counts it. */
const monthNow = () => new Date(h.clock.now.getTime() + 4 * 60 * MIN).toISOString().slice(0, 7);

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
      { key: "messages.send_queue", scope: null },
    ],
    totp: false,
  });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  monday = new Date(dubai("2026-09-21T13:00:00").getTime() + week++ * 7 * DAY);
  h.clock.now = monday;
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  h.whatsappSendQueued.length = 0;
  meta.sent.length = 0;
  meta.templates.clear();
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await checkIn();
  numberId = await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await (
    await as(admin)
  ).inject({
    method: "PUT",
    url: "/api/v1/integrations/whatsapp",
    payload: { replyFromLume: true },
  });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
});

describe("the engine", () => {
  it("first messages go as templates: written, revealed, sent one at a time, paced", async () => {
    const leads = await Promise.all(["Meera Iyer", "Rohan Gupta", "Anika Rao"].map((n) => lead(n)));
    const run = await start(leads);
    await tick();
    // One lead at a time: the first is being written, the screen reveals it before it goes.
    const writing = (await leadsOf(run)).filter((l) => l.state === "writing");
    expect(writing).toHaveLength(1);
    expect(writing[0]!.draft).toMatch(/^Hi \w+, thanks for your enquiry\. Can we help\?$/);
    expect(await outbox()).toHaveLength(0);
    await tick(10 * S);
    expect(await outbox()).toEqual([expect.objectContaining({ status: "queued", autopilot_run_id: run })]);
    // Paced: never a burst. 5 hours left today over the day's 250 → about a minute apart.
    await tick(10 * S);
    expect(await outbox()).toHaveLength(1);
    for (let i = 0; i < 6; i++) await tick(MIN);
    const sent = await outbox();
    expect(sent).toHaveLength(3);
    const gaps = sent.slice(1).map((s, i) => s.created_at.getTime() - sent[i]!.created_at.getTime());
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20 * S);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(3);
    expect(meta.sent.every((m) => (m.body as { type: string }).type === "template")).toBe(true);
    // On each lead's timeline as sent by LUME AI for the speaker.
    const acts = await h.queryAll<{ user_id: string; via: string; run: string }>(
      "SELECT user_id, payload->>'via' AS via, payload->>'runId' AS run FROM activities WHERE type = 'whatsapp_sent' AND lead_id = ANY($1)",
      [leads],
    );
    expect(acts).toHaveLength(3);
    expect(acts.every((a) => a.user_id === admin.id && a.via === "ai_autopilot" && a.run === run)).toBe(true);
    expect((await leadsOf(run)).every((l) => l.state === "sent")).toBe(true);
    // And the thread says so: LUME AI, in this run, for the speaker.
    const thread = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/leads/${leads[0]}/whatsapp` })
    ).json();
    expect(thread.messages).toEqual([
      expect.objectContaining({
        direction: "out",
        sentBy: expect.objectContaining({ id: admin.id }),
        lumeAi: { runId: run },
      }),
    ]);
  });

  it("outside working hours nothing is written; it starts at the next working day's start", async () => {
    h.clock.now = new Date(monday.getTime() + 6.5 * 60 * MIN); // 19:30
    const run = await start([await lead("Meera Iyer")]);
    await tick();
    expect((await leadsOf(run))[0]!.state).toBe("up_next");
    h.clock.now = new Date(monday.getTime() + 20 * 60 * MIN); // Tuesday 09:00
    await tick();
    expect((await leadsOf(run))[0]!.state).toBe("writing");
  });

  it("a lead missing a template's value gets one that doesn't need it, or is skipped with why", async () => {
    await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
    meta.templates.clear();
    await approvedTemplate(
      h,
      meta,
      admin,
      "Hi {{lead.first_name}}, {{owner.first_name}} here from the studio.",
    );
    const ownerless = await lead("Meera Iyer", { owner: null });
    const run = await start([ownerless]);
    await tick();
    expect(await stateOf(run, ownerless)).toMatchObject({
      state: "skipped",
      active: false,
      reason: "No approved template fits this lead yet: it has no Owner's first name.",
    });
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry.");
    const second = await lead("Rohan Gupta", { owner: null });
    const run2 = await start([second]);
    await tick();
    expect(await stateOf(run2, second)).toMatchObject({
      state: "writing",
      draft: "Hi Rohan, thanks for your enquiry.",
    });
  });

  it("pause between commit and the job: nothing reaches Meta, and the thread doesn't show it", async () => {
    const one = await lead("Meera Iyer");
    const run = await start([one]);
    await tick();
    await tick(10 * S);
    expect(await outbox()).toHaveLength(1);
    await pauseRun(h.ownerPool, run, "person");
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(0);
    expect((await outbox())[0]!.status).toBe("cancelled");
    const thread = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/leads/${one}/whatsapp` })
    ).json();
    expect(thread.messages).toEqual([]);
    // It never went, so it isn't counted as gone: Resume writes the first message again, and it goes.
    expect((await stateOf(run, one)).state).toBe("up_next");
    await resumeRun(h.ownerPool, run);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(1);
    expect((await stateOf(run, one)).state).toBe("sent");
  });

  it("a follow-up held by Pause is due again on Resume, not counted as sent", async () => {
    const one = await lead("Meera Iyer");
    const run = await start([one]);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    h.clock.advance(2 * DAY + MIN);
    await tick();
    await tick(10 * S);
    await pauseRun(h.ownerPool, run, "person");
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(1);
    const row = await h.queryAll<{ state: string; follow_ups_sent: number }>(
      "SELECT state, follow_ups_sent FROM autopilot_leads WHERE run_id = $1",
      [run],
    );
    expect(row[0]).toEqual({ state: "sent", follow_ups_sent: 0 });
    await resumeRun(h.ownerPool, run);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(2);
  });

  it("pause during writing: the draft stays and nothing is sent; resume sends that same draft", async () => {
    const one = await lead("Meera Iyer");
    const run = await start([one]);
    await tick();
    const draft = (await stateOf(run, one)).draft;
    await pauseRun(h.ownerPool, run, "person");
    await tick(10 * MIN);
    expect(await outbox()).toHaveLength(0);
    expect(await stateOf(run, one)).toMatchObject({ state: "writing", draft });
    await resumeRun(h.ownerPool, run);
    await tick(10 * S);
    expect(await outbox()).toHaveLength(1);
    const text = await h.queryAll<{ text: string }>("SELECT text FROM whatsapp_outbox");
    expect(text[0]!.text).toBe(draft);
  });

  it("end: nothing more is sent, and every lead keeps its state", async () => {
    const leads = await Promise.all(["Meera Iyer", "Rohan Gupta"].map((n) => lead(n)));
    const run = await start(leads);
    await tick();
    await endRun(h.ownerPool, run);
    await tick(30 * MIN);
    expect(await outbox()).toHaveLength(0);
    expect((await runOf(run)).status).toBe("ended");
    const states = (await leadsOf(run)).map((l) => [l.state, l.active]).sort();
    expect(states).toEqual([
      ["up_next", false],
      ["writing", false],
    ]);
  });

  it("at the month's allowance the run pauses; a top-up resumes it by itself", async () => {
    licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1 });
    await checkIn();
    // Two templates fit: choosing one is a LUME AI call (with one, nothing is asked).
    await approvedTemplate(h, meta, admin, "Hello {{lead.first_name}}, we got your enquiry.");
    const leads = await Promise.all(["Meera Iyer", "Rohan Gupta"].map((n) => lead(n)));
    const run = await start(leads);
    await tick();
    await tick(10 * S);
    await tick(5 * MIN);
    expect(await runOf(run)).toEqual({ status: "paused", pause_reason: "month" });
    licence.setPlan({
      places: null,
      modules: ALL_MODULES,
      aiReadsHourly: null,
      aiCallsMonthly: 1,
      aiTopUps: [{ month: monthNow(), calls: 5 }],
    });
    await checkIn();
    await tick(MIN);
    expect((await runOf(run)).status).toBe("running");
    await tick(10 * S);
    expect(await outbox()).toHaveLength(2);
  });

  it("the speaker loses the right to message: the run pauses and admins hear why", async () => {
    const mine = await lead("Meera Iyer", { owner: rep.id });
    const run = await start([mine], rep);
    // Their role changed: they may still see their leads, but no longer message them.
    await h.ownerPool.query("DELETE FROM user_roles WHERE user_id = $1", [rep.id]);
    await h.grant(rep.id, [{ key: "leads.view", scope: "own" }]);
    await h.waitForRbacNotify();
    await tick();
    expect(await runOf(run)).toEqual({ status: "paused", pause_reason: "speaker" });
    const told = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/notifications" })).json()
      .items;
    expect(told.map((n: { title: string }) => n.title)).toContain(
      "LUME AI paused a run: its speaker can't message leads",
    );
  });

  it("a drop to yellow pauses every run on the number", async () => {
    const run = await start([await lead("Meera Iyer")]);
    await onNumberHealth(h.ownerPool, numberId, { quality: "yellow" }, h.clock.now);
    expect(await runOf(run)).toEqual({ status: "paused", pause_reason: "quality" });
    await tick(MIN);
    expect(await outbox()).toHaveLength(0);
  });
});
