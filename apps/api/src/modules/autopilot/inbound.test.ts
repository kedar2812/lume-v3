import { ALL_GRANTS, AUTOPILOT_PRESETS, newId } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { echo, inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * Replies, stop, and taking a lead over (Autopilot A2, Task 7; spec 2026-10-19 §2.1, §3): a lead who writes is answered
 * inside the 24 hours; one who says stop, in any words, never hears from the business again; a person who messages a
 * lead, or takes it over, takes it out of LUME AI's hands.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const licence = testLicence({ instanceId: "LUME-TEST-INBOUND", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
const PHONE = "+919876543210";
let week = 0;
let monday = new Date("2026-09-21T09:00:00Z"); // 13:00 in Dubai

const as = (u: U) => h.signIn(u);
const post = async (u: U, url: string, payload: unknown = {}) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const start = async (leadIds: string[], u: U = admin) => {
  const r = await post(u, "/api/v1/autopilot/runs", {
    leadIds,
    goal: { kind: "reply" },
    speakerId: null,
    permissions: AUTOPILOT_PRESETS.hands_off,
    followUpDays: [2, 5],
    dailyCap: null,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().run.id as string;
};
const stateOf = async (run: string, leadId: string) =>
  (
    await h.queryAll<{ state: string; draft: string | null; active: boolean; next_at: Date | null }>(
      "SELECT state, draft, active, next_at FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2",
      [run, leadId],
    )
  )[0]!;
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
/** The lead writes on WhatsApp now, these words. */
const writes = async (text: string) => {
  const r = await deliver(
    h,
    inbound({
      from: PHONE.slice(1),
      id: `wamid.${newId()}`,
      at: h.clock.now.toISOString(),
      type: "text",
      text: { body: text },
    }),
  );
  expect(r.statusCode).toBe(200);
  await h.runWhatsApp();
};
/** The first message has gone (written, revealed, sent, delivered to Meta). */
const firstMessage = async (run: string, leadId: string) => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
  expect((await stateOf(run, leadId)).state).toBe("sent");
};
const textsSent = () =>
  meta.sent
    .filter((m) => (m.body as { type: string }).type === "text")
    .map((m) => (m.body as { text: { body: string } }).text.body);
const checkIn = async () => (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });

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
  monday = new Date(new Date("2026-09-21T09:00:00Z").getTime() + week++ * 7 * DAY);
  h.clock.now = monday;
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("DELETE FROM ai_profile");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  h.whatsappSendQueued.length = 0;
  h.whatsappQueued.length = 0;
  meta.sent.length = 0;
  meta.templates.clear();
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await checkIn();
  await seedNumber(h, { runAs: admin.id });
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

describe("replies, stop, taking over", () => {
  it("a reply inside the run is answered inside the 24 hours, as free text", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await firstMessage(run, lead);
    h.clock.advance(5 * MIN);
    await writes("How much is a modular kitchen?");
    expect((await stateOf(run, lead)).state).toBe("replied");
    await tick();
    expect((await stateOf(run, lead)).state).toBe("writing");
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(textsSent()).toEqual(["Thanks for your message! Happy to help."]);
    expect((await stateOf(run, lead)).state).toBe("talking");
  });

  it("stop in other words: do not contact, one apology, and nobody can message them after", async () => {
    for (const words of ["please don't message me again", "band karo"]) {
      meta.sent.length = 0;
      await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
      const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
      const run = await start([lead]);
      await firstMessage(run, lead);
      await writes(words);
      expect(await stateOf(run, lead)).toMatchObject({ state: "stopped", active: false });
      await h.runWhatsAppSend();
      expect(textsSent()).toEqual(["Sorry for the messages. You won't hear from us again."]);
      // No one in LUME, no later run.
      const reply = await post(admin, `/api/v1/leads/${lead}/whatsapp/messages`, {
        clientKey: newId(),
        text: "Hi",
      });
      expect(reply.json().error?.code).toBe("DO_NOT_CONTACT");
      const again = await post(admin, "/api/v1/autopilot/runs", {
        leadIds: [lead],
        goal: { kind: "reply" },
        speakerId: null,
        permissions: AUTOPILOT_PRESETS.hands_off,
        followUpDays: [2],
        dailyCap: null,
      });
      expect(again.json().skipped).toEqual([{ leadId: lead, why: "Asked not to be messaged" }]);
      // Lifted by an admin: messages may go again.
      expect(
        (await (await as(admin)).inject({ method: "DELETE", url: `/api/v1/leads/${lead}/do-not-contact` }))
          .statusCode,
      ).toBe(200);
    }
  });

  it("a stop while the run is paused is still kept; nothing is sent", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await firstMessage(run, lead);
    await post(admin, `/api/v1/autopilot/runs/${run}/pause`);
    meta.sent.length = 0;
    await writes("STOP");
    expect((await stateOf(run, lead)).state).toBe("stopped");
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(0);
    const view = (await (await as(admin)).inject({ method: "GET", url: `/api/v1/leads/${lead}` })).json()
      .lead;
    expect(view.doNotContact).toMatchObject({ by: null, reason: "Said stop on WhatsApp" });
  });

  it("outside hours a reply waits when the business chose wait, and goes at once when it chose reply any time", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await firstMessage(run, lead);
    h.clock.now = new Date(monday.getTime() + 8 * 60 * MIN); // 21:00 in Dubai
    await writes("Is the studio open tomorrow?");
    await tick();
    const waited = await stateOf(run, lead);
    expect(waited.state).toBe("replied");
    expect(waited.next_at?.toISOString()).toBe(new Date(monday.getTime() + 20 * 60 * MIN).toISOString()); // 09:00

    await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: "/api/v1/ai/profile",
      payload: { standing: { outsideHours: "reply_any_time" } },
    });
    await post(admin, `/api/v1/autopilot/runs/${run}/end`);
    const run2 = await start([lead]);
    await h.queryAll(
      "UPDATE autopilot_leads SET state = 'replied', last_inbound_at = $2, first_sent_at = $3 WHERE run_id = $1",
      [run2, h.clock.now, monday],
    );
    await tick();
    expect((await stateOf(run2, lead)).state).toBe("writing");
  });

  it("a person's message from the phone takes the lead out of LUME AI's hands", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await firstMessage(run, lead);
    const r = await deliver(
      h,
      echo({
        to: PHONE.slice(1),
        id: `wamid.${newId()}`,
        at: h.clock.now.toISOString(),
        text: "Hi, Priya here",
      }),
    );
    expect(r.statusCode).toBe(200);
    await h.runWhatsApp();
    expect((await stateOf(run, lead)).state).toBe("with_you");
    await writes("Thanks Priya");
    await tick(MIN);
    expect((await stateOf(run, lead)).state).toBe("with_you");
  });

  it("take over mid-writing keeps the half-written text for them; hand back carries on", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await tick();
    const draft = (await stateOf(run, lead)).draft;
    const took = await post(admin, `/api/v1/autopilot/runs/${run}/leads/${lead}/take-over`);
    expect(took.statusCode).toBe(200);
    expect(took.json()).toMatchObject({ state: "with_you", draft });
    await tick(MIN);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(0);
    expect((await post(admin, `/api/v1/autopilot/runs/${run}/leads/${lead}/hand-back`)).json().state).toBe(
      "up_next",
    );
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(1);
  });

  it("pause, resume and end: from any device, by the person who started it or an admin only", async () => {
    const mine = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([mine], admin);
    expect((await post(rep, `/api/v1/autopilot/runs/${run}/pause`)).statusCode).toBe(403);
    const paused = await post(admin, `/api/v1/autopilot/runs/${run}/pause`);
    expect(paused.json().run).toMatchObject({ status: "paused", pauseReason: "person" });
    expect((await post(admin, `/api/v1/autopilot/runs/${run}/resume`)).json().run.status).toBe("running");
    expect((await post(admin, `/api/v1/autopilot/runs/${run}/end`)).json().run.status).toBe("ended");
  });
});
