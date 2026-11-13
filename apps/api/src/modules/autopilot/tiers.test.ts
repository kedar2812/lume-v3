import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply, type PlanTier } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { REPLIES_HANDED } from "./engine";

/**
 * Plans and pricing (November 2026): only the features a client's tier has work. Base is LUME without AI; Pro is
 * Autopilot first messages and follow-ups, next steps and catch-ups; Max and Enterprise add Autopilot replies and Ask
 * me. A plan without a tier locks nothing.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let goalStage: string;
const licence = testLicence({ instanceId: "LUME-TEST-TIERS", now: () => h.clock.now });
/** What this LUME asked its licence server for (top-ups, plans). */
const asked: { url: string; body: Record<string, unknown> }[] = [];
const fetchLicence = licence.options.fetch!;
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;

const tier = (t: PlanTier | null) =>
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiLeadsMonthly: null, tier: t });
const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}, u: U = admin) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const get = async (url: string, u: U = admin) => (await as(u)).inject({ method: "GET", url });
const onTier = async (t: PlanTier | null) => {
  tier(t);
  expect((await post("/api/v1/licence/check")).statusCode).toBeLessThan(300);
};
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
const sendNext = async () => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
};
const phoneOf: Record<string, string> = {};
let n = 0;
const lead = async (name: string) => {
  const phone = `+9198771${String(++n).padStart(5, "0")}`;
  const id = await h.seedLead({ ownerId: rep.id, name, phone });
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
    await h.queryAll<{ state: string; reason: string | null; card: { quote: string | null } | null }>(
      "SELECT state, reason, card FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2",
      [run, leadId],
    )
  )[0]!;
const replyReads = async (leadId: string) =>
  (
    await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_reads WHERE task = 'autopilot_reply' AND lead_id = $1",
      [leadId],
    )
  )[0]!.n;
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

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: {
      ...licence.options,
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/v1/topup")) {
          asked.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          return new Response(JSON.stringify({ asked: true }), { status: 201 });
        }
        return fetchLicence(url, init);
      }) as typeof fetch,
    },
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  h.clock.now = new Date("2026-09-21T09:00:00Z");
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
  await onTier(null);
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
  h.clock.now = new Date(new Date("2026-10-05T09:00:00Z").getTime() + week++ * 35 * DAY);
  await h.queryAll("DELETE FROM autopilot_runs");
  meta.sent.length = 0;
  asked.length = 0;
});

describe("Pro: Autopilot writes first and follows up; replies are the team's", () => {
  it("every action LUME AI only takes in a reply is locked, saying Max and how to get it; the rest work", async () => {
    await onTier("pro");
    const setup = (await get("/api/v1/autopilot/setup")).json();
    expect(setup.available.first_messages).toEqual({ ok: true });
    expect(setup.available.follow_ups).toEqual({ ok: true });
    expect(setup.available.hand_to_rep).toEqual({ ok: true });
    for (const a of ["replies", "send_files", "book_meetings", "move_stages", "answer_prices", "mark_lost"])
      expect(setup.available[a]).toEqual({
        ok: false,
        why: "LUME AI does this in its replies, on Max and Enterprise.",
        fixHref: "/settings/about#plan",
        fixLabel: "Upgrade to Max",
      });
  });

  it("a run started on Pro keeps replies at Never, whatever was chosen", async () => {
    await onTier("pro");
    const run = await startRun([await lead("Kavya Rao")]);
    const [row] = await h.queryAll<{ p: Record<string, string> }>(
      "SELECT permissions AS p FROM autopilot_runs WHERE id = $1",
      [run],
    );
    expect(row!.p.replies).toBe("never");
    expect(row!.p.first_messages).toBe("go");
  });

  it("a lead who writes back is handed to the team at once, with their words, and no AI read is spent on it", async () => {
    await onTier("pro");
    const kavya = await lead("Kavya Rao");
    const run = await startRun([kavya]);
    await sendNext();
    expect(meta.sent).toHaveLength(1);
    await writes(kavya, "Is the 3 month plan still on?");
    await sendNext();
    expect(await stateOf(run, kavya)).toMatchObject({
      state: "needs_you",
      reason: REPLIES_HANDED,
      card: expect.objectContaining({ quote: "Is the 3 month plan still on?" }),
    });
    expect(await replyReads(kavya)).toBe(0);
    expect(meta.sent).toHaveLength(1);
  });

  it("a run from Max carries on writing first, but stops replying once the plan is Pro", async () => {
    await onTier("max");
    const arjun = await lead("Arjun Mehta");
    const run = await startRun([arjun]);
    await sendNext();
    await onTier("pro");
    provider.script("autopilot_reply", [reply({ message: "Yes, it is." })]);
    await writes(arjun, "Is the offer still on?");
    await sendNext();
    expect((await stateOf(run, arjun)).reason).toBe(REPLIES_HANDED);
    expect(await replyReads(arjun)).toBe(0);
  });

  it("a reply waiting for Ask me from Max can't be sent once the plan is Pro; declining still works", async () => {
    await onTier("max");
    const isha = await lead("Isha Nair");
    const run = await startRun([isha], { ...AUTOPILOT_PRESETS.hands_off, replies: "ask" });
    await sendNext();
    provider.script("autopilot_reply", [reply({ message: "Yes, we do weekend sessions." })]);
    await writes(isha, "Do you do weekends?");
    await sendNext();
    expect((await stateOf(run, isha)).state).toBe("needs_you");
    const [ask] = await h.queryAll<{ id: string }>("SELECT id FROM autopilot_asks WHERE lead_id = $1", [
      isha,
    ]);
    await onTier("pro");
    const r = await post(`/api/v1/autopilot/asks/${ask!.id}/approve`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "PLAN_TIER",
      message: "Autopilot replies are on Max and Enterprise. Send your own reply from the lead's chat.",
    });
    expect((await post(`/api/v1/autopilot/asks/${ask!.id}/decline`)).statusCode).toBe(200);
    expect(meta.sent).toHaveLength(1);
  });
});

describe("Max and no tier: replies work as before", () => {
  it.each(["max", "enterprise", null] as const)(
    "%s: replies, files and meetings aren't locked by the plan",
    async (t) => {
      await onTier(t);
      const setup = (await get("/api/v1/autopilot/setup")).json();
      expect(setup.available.replies).toEqual({ ok: true });
      expect(setup.available.move_stages).toEqual({ ok: true });
    },
  );
});

describe("Base: LUME without AI", () => {
  it("switches LUME AI off once, tells admins why, and says Pro wherever it's asked for", async () => {
    await onTier("base");
    expect((await get("/api/v1/ai")).json().on).toBe(false);
    const setup = (await get("/api/v1/autopilot/setup")).json();
    expect(setup.ready).toEqual({
      ok: false,
      code: "AI_OFF",
      message: "LUME AI is on Pro, Max and Enterprise. Your LUME is on Base.",
      fixHref: "/settings/about#plan",
    });
    const on = await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
    expect(on.statusCode).toBe(409);
    expect(on.json().error).toMatchObject({
      code: "PLAN_MODULE",
      message: "LUME AI is on Pro, Max and Enterprise. Ask LUME about Pro from Settings → About.",
    });
    const items = (await get("/api/v1/notifications")).json().items as { title: string; body: string }[];
    expect(
      items.some((i) => i.title === "LUME AI was switched off" && /Pro, Max and Enterprise/.test(i.body)),
    ).toBe(true);
    // Back on a tier with LUME AI, an admin switches it on again.
    await onTier("pro");
    expect(
      (
        await (
          await as(admin)
        ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } })
      ).statusCode,
    ).toBe(200);
  });
});

describe("the plan as people see it, and asking about the next one", () => {
  it("everyone sees the tier; only admins see places", async () => {
    await onTier("pro");
    expect((await get("/api/v1/licence", rep)).json()).toMatchObject({ tier: "pro", plan: null });
    expect((await get("/api/v1/licence")).json()).toMatchObject({ tier: "pro", plan: { tier: "pro" } });
    await onTier(null);
    expect((await get("/api/v1/licence", rep)).json().tier).toBeNull();
  });

  it("an admin asks about a higher tier: it reaches the licence server in words, once a tap", async () => {
    await onTier("pro");
    const r = await post("/api/v1/plan/ask", { tier: "max" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ asked: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toMatchObject({ note: "They'd like to move to Max." });
  });

  it("refuses a tier that isn't higher, a tier it doesn't know, and anyone who doesn't manage settings", async () => {
    await onTier("max");
    expect((await post("/api/v1/plan/ask", { tier: "pro" })).statusCode).toBe(409);
    expect((await post("/api/v1/plan/ask", { tier: "max" })).statusCode).toBe(409);
    expect((await post("/api/v1/plan/ask", { tier: "gold" })).statusCode).toBe(400);
    expect((await post("/api/v1/plan/ask", { tier: "enterprise" }, rep)).statusCode).toBe(403);
    expect(asked).toHaveLength(0);
  });
});
