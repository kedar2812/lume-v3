import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * Ask me, and Ready for you (Autopilot A2, Task 8; spec 2026-10-19 §1.3, §2, §11): what's set to Ask me waits for one tap;
 * a lead who reaches the goal, or needs a person, comes to Ready for you with the deal and their own words.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let goalStage: { id: string; name: string };
const licence = testLicence({ instanceId: "LUME-TEST-READY", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const DAY = 24 * 3_600_000;
const PHONE = "+919876543210";
let week = 0;

const as = (u: U) => h.signIn(u);
const post = async (u: U, url: string, payload: unknown = {}) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const start = async (leadIds: string[], o: Record<string, unknown> = {}) => {
  const r = await post(admin, "/api/v1/autopilot/runs", {
    leadIds,
    goal: { kind: "stage", stageId: goalStage.id },
    speakerId: null,
    permissions: AUTOPILOT_PRESETS.hands_off,
    followUpDays: [2, 5],
    dailyCap: null,
    ...o,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().run.id as string;
};
const rowOf = async (run: string, leadId: string) =>
  (
    await h.queryAll<{ state: string; card: { headline: string; quote: string | null } | null }>(
      "SELECT state, card FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2",
      [run, leadId],
    )
  )[0]!;
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
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
  ...o,
});
/** The lead has had its first message, and has just written these words. */
const leadWrote = async (words: string) => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
  await writes(words);
};
const bell = async (u: U) =>
  (await (await as(u)).inject({ method: "GET", url: "/api/v1/notifications" })).json().items as {
    kind: string;
    title: string;
    leadId: string | null;
  }[];
const textsSent = () =>
  meta.sent
    .filter((m) => (m.body as { type: string }).type === "text")
    .map((m) => (m.body as { text: { body: string } }).text.body);

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
    ],
    totp: false,
  });
  const { pipelineId } = await h.config();
  goalStage = (
    await h.ownerPool.query<{ id: string; name: string }>(
      "SELECT id, name FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!;
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  h.clock.now = new Date(new Date("2026-09-21T09:00:00Z").getTime() + week++ * 7 * DAY);
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("DELETE FROM ai_profile");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  await h.queryAll("DELETE FROM notifications WHERE kind IN ('autopilot_ask', 'autopilot_ready')");
  h.whatsappSendQueued.length = 0;
  meta.sent.length = 0;
  meta.templates.clear();
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
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
  await (
    await as(admin)
  ).inject({
    method: "PATCH",
    url: "/api/v1/ai/profile",
    payload: {
      knows: {
        prices: [{ id: newId(), item: "Modular kitchen", price: 380000, unit: "per kitchen", notes: "" }],
      },
    },
  });
});

describe("Ask me, and Ready for you", () => {
  it("an Ask me waits for one tap, tells the person who started the run once, and then goes at once", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], {
      permissions: { ...AUTOPILOT_PRESETS.hands_off, answer_prices: "ask" },
    });
    await leadWrote("How much is a modular kitchen?");
    provider.script("autopilot_reply", [reply({ message: "A modular kitchen is ₹3,80,000 all in." })]);
    await tick();
    expect((await rowOf(run, lead)).state).toBe("needs_you");
    const asks = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run}` })
    ).json().asks;
    expect(asks).toEqual([expect.objectContaining({ leadId: lead, action: "answer_prices" })]);
    const told = (await bell(admin)).filter((n) => n.kind === "autopilot_ask");
    expect(told).toEqual(
      [
        {
          kind: "autopilot_ask",
          title: "LUME AI is waiting for you: Answer price questions for Sneha",
          leadId: lead,
        },
      ].map((x) => expect.objectContaining(x)),
    );
    expect((await post(admin, `/api/v1/autopilot/asks/${asks[0].id}/approve`)).statusCode).toBe(200);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(textsSent()).toEqual(["A modular kitchen is ₹3,80,000 all in."]);
    expect((await rowOf(run, lead)).state).toBe("talking");
  });

  it("declined: nothing is sent and the lead is handed to the person", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], {
      permissions: { ...AUTOPILOT_PRESETS.hands_off, answer_prices: "ask" },
    });
    await leadWrote("How much is a modular kitchen?");
    provider.script("autopilot_reply", [reply({ message: "A modular kitchen is ₹3,80,000 all in." })]);
    await tick();
    const ask = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run}` })
    ).json().asks[0];
    expect((await post(rep, `/api/v1/autopilot/asks/${ask.id}/decline`)).statusCode).toBe(404);
    expect((await post(admin, `/api/v1/autopilot/asks/${ask.id}/decline`)).statusCode).toBe(200);
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(textsSent()).toEqual([]);
    expect((await rowOf(run, lead)).state).toBe("with_you");
  });

  it("a move into the goal stage is converted, with the lead's own words, and the owner hears", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead]);
    await leadWrote("Saturday works for the visit");
    provider.script("autopilot_reply", [reply({ message: "Lovely, see you then.", stageId: goalStage.id })]);
    await tick();
    await tick(10 * S);
    expect(await rowOf(run, lead)).toEqual({
      state: "ready",
      card: { headline: `Reached ${goalStage.name}`, quote: "Saturday works for the visit" },
    });
    const title = `Sneha: Reached ${goalStage.name}. Want to take over?`;
    expect((await bell(admin)).map((n) => n.title)).toContain(title);
    // Hand a lead to a rep is Go ahead in Hands-off: the lead's own rep hears too.
    expect((await bell(rep)).map((n) => n.title)).toContain(title);
  });

  it("LUME AI's reason ending in a full stop reads once in the notice, not twice", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    await start([lead], {
      goal: { kind: "brief", text: "Get them to agree to a free site visit this week." },
    });
    await leadWrote("Okay, Saturday works");
    provider.script("autopilot_reply", [
      reply({
        kind: "converted",
        message: null,
        reason: "Agreed to meet.",
        evidence: "Okay, Saturday works",
      }),
    ]);
    await tick();
    expect((await bell(admin)).map((n) => n.title)).toContain("Sneha: Agreed to meet. Want to take over?");
  });

  it("a written goal converts on LUME AI's judgement, with the lead's words as evidence", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], {
      goal: { kind: "brief", text: "Get them to agree to a free site visit this week." },
    });
    await leadWrote("Okay, Saturday works");
    provider.script("autopilot_reply", [
      reply({
        kind: "converted",
        message: null,
        reason: "Site visit agreed",
        evidence: "Okay, Saturday works",
      }),
    ]);
    await tick();
    expect(await rowOf(run, lead)).toEqual({
      state: "ready",
      card: { headline: "Site visit agreed", quote: "Okay, Saturday works" },
    });
  });

  it("Get a reply: a reply is the goal reached", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], { goal: { kind: "reply" } });
    await leadWrote("Yes, interested");
    expect(await rowOf(run, lead)).toEqual({
      state: "ready",
      card: { headline: "Replied", quote: "Yes, interested" },
    });
  });

  it("carry on sends LUME AI back to the conversation", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], { goal: { kind: "reply" } });
    await leadWrote("Yes, interested");
    expect((await post(admin, `/api/v1/autopilot/runs/${run}/leads/${lead}/carry-on`)).json().state).toBe(
      "replied",
    );
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    expect(textsSent()).toEqual(["Thanks for your message! Happy to help."]);
  });

  /** A price question LUME AI asks about (Ask me), for the tests below. */
  const asked = async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: PHONE });
    const run = await start([lead], {
      permissions: { ...AUTOPILOT_PRESETS.hands_off, answer_prices: "ask" },
    });
    await leadWrote("How much is a modular kitchen?");
    provider.script("autopilot_reply", [reply({ message: "A modular kitchen is ₹3,80,000 all in." })]);
    await tick();
    const ask = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run}` })
    ).json().asks[0] as { id: string };
    return { lead, run, ask };
  };
  const sentAfter = async () => {
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    return textsSent();
  };

  it("taken over after LUME AI asked: the ask is gone, and approving it sends nothing (review 2026-10-26 A3)", async () => {
    const { lead, run, ask } = await asked();
    expect((await post(admin, `/api/v1/autopilot/runs/${run}/leads/${lead}/take-over`)).statusCode).toBe(200);
    const r = await post(admin, `/api/v1/autopilot/asks/${ask.id}/approve`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("That isn't waiting for you any more.");
    expect(await sentAfter()).toEqual([]);
    expect((await rowOf(run, lead)).state).toBe("with_you");
  });

  it("the lead wrote again after LUME AI asked: what it prepared answered an older message, so the ask is gone", async () => {
    const { lead, run, ask } = await asked();
    await writes("Actually, I need a wardrobe too");
    expect((await post(admin, `/api/v1/autopilot/asks/${ask.id}/approve`)).statusCode).toBe(404);
    expect(await sentAfter()).toEqual([]);
    expect((await rowOf(run, lead)).state).toBe("needs_you");
  });

  it("the lead said stop after LUME AI asked: the ask is gone; only the one apology goes", async () => {
    const { ask } = await asked();
    await writes("Stop");
    expect((await post(admin, `/api/v1/autopilot/asks/${ask.id}/approve`)).statusCode).toBe(404);
    expect(await sentAfter()).not.toContain("A modular kitchen is ₹3,80,000 all in.");
  });

  it("a lead no longer waiting on the ask, however it got there: approving sends nothing and says why", async () => {
    const { lead, run, ask } = await asked();
    // Moved on by a path that left the ask behind: the approval itself checks the lead.
    await h.queryAll("UPDATE autopilot_leads SET state = 'with_you' WHERE run_id = $1 AND lead_id = $2", [
      run,
      lead,
    ]);
    const r = await post(admin, `/api/v1/autopilot/asks/${ask.id}/approve`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "ASK_GONE",
      message: "This lead has moved on since LUME AI asked. Nothing was sent.",
    });
    expect(await sentAfter()).toEqual([]);
    // And the screen no longer offers it.
    const asks = (
      await (await as(admin)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run}` })
    ).json().asks;
    expect(asks).toEqual([]);
  });
});
