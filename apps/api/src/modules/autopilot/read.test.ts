import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply, type Grant } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * What a run's live view reads (Autopilot A3, Task 2; spec 2026-10-19 §2): the message being written while it's revealed,
 * LUME AI's own one-line reason, and who may pause it. Each person sees only the leads they may see.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let adminName: string;
let rep: U;
let other: U;
const licence = testLicence({ instanceId: "LUME-TEST-AUTOPILOT-READ", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
let week = 0;

const as = (u: U) => h.signIn(u);
const get = async (u: U, url: string) => {
  const r = await (await as(u)).inject({ method: "GET", url });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const phoneOf: Record<string, string> = {};
const lead = async (name: string, owner: U) => {
  const phone = `+9198765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`;
  const id = await h.seedLead({ ownerId: owner.id, name, phone });
  phoneOf[id] = phone;
  return id;
};
const BRIEF = { kind: "brief", text: "Get them to visit our studio this week to see finished work." };
const start = async (leadIds: string[], u: U, goal: object = { kind: "reply" }) => {
  const r = await (
    await as(u)
  ).inject({
    method: "POST",
    url: "/api/v1/autopilot/runs",
    payload: {
      leadIds,
      goal,
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().run.id as string;
};
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
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
type LeadView = {
  leadId: string;
  state: string;
  thought: string | null;
  repliedAt: string | null;
  draft: {
    text: string;
    kind: string;
    templateName: string | null;
    startedAt: string;
    revealedBy: string;
    marks: [number, number][];
  } | null;
};
const leadIn = async (u: U, run: string, leadId: string) =>
  ((await get(u, `/api/v1/autopilot/runs/${run}`)).leads as LeadView[]).find((l) => l.leadId === leadId);
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
  adminName = (await h.queryAll<{ name: string }>("SELECT name FROM users WHERE id = $1", [admin.id]))[0]!
    .name;
  const repGrants: Grant[] = [
    { key: "leads.view", scope: "own" },
    { key: "messages.send", scope: "own" },
    { key: "messages.send_queue", scope: null },
  ];
  rep = await h.seedUser({ grants: repGrants, totp: false });
  other = await h.seedUser({ grants: repGrants, totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  // Each test on its own Monday, 13:00 in Dubai (inside hours); time only moves forward (licence check-ins).
  h.clock.now = new Date(new Date("2026-09-21T09:00:00Z").getTime() + week++ * 7 * DAY);
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  meta.sent.length = 0;
  meta.templates.clear();
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await checkIn();
  await seedNumber(h, { runAs: admin.id });
  const a = await as(admin);
  await a.inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await a.inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
});

describe("the live view's fields", () => {
  it("a first message being written: its words, an approved template's name, and why, until it's sent", async () => {
    const meera = await lead("Meera Iyer", admin);
    const run = await start([meera], admin);
    await tick();
    const writing = await leadIn(admin, run, meera);
    expect(writing).toMatchObject({
      state: "writing",
      draft: {
        text: "Hi Meera, thanks for your enquiry. Can we help?",
        kind: "template",
        templateName: expect.stringMatching(/^T /),
        startedAt: h.clock.now.toISOString(),
        revealedBy: expect.any(String),
      },
      thought: "Only one approved template fits Meera, so LUME AI uses it.",
    });
    expect(new Date(writing!.draft!.revealedBy).getTime()).toBeGreaterThan(h.clock.now.getTime());
    expect(writing!.repliedAt).toBeNull();
    // Where the template's filled values sit, for the screen to highlight as it types.
    const d = writing!.draft!;
    expect(d.marks.map(([a, b]) => d.text.slice(a, b))).toEqual(["Meera"]);
    await tick(10 * S);
    expect(await leadIn(admin, run, meera)).toMatchObject({ state: "sent", draft: null, thought: null });
  });

  it("with several templates that fit, the thought is LUME AI's own reason for its choice", async () => {
    const hello = await approvedTemplate(
      h,
      meta,
      admin,
      "Hello {{lead.first_name}}, how can we help with your enquiry?",
    );
    const meera = await lead("Meera Iyer", admin);
    const run = await start([meera], admin);
    provider.script("autopilot_first", [{ templateId: hello, why: "The warmer hello suits a new enquiry." }]);
    await tick();
    const l = await leadIn(admin, run, meera);
    expect(l?.state).toBe("writing");
    expect(l?.draft?.text).toBe("Hello Meera, how can we help with your enquiry?");
    expect(l?.thought).toBe("The warmer hello suits a new enquiry.");
  });

  it("a reply being written carries LUME AI's reason", async () => {
    const meera = await lead("Meera Iyer", admin);
    // A written goal: "Get a reply" would be reached by her reply itself.
    const run = await start([meera], admin, BRIEF);
    await tick();
    await tick(10 * S);
    h.clock.advance(MIN);
    await writes(meera, "Do you do kitchens?");
    provider.script("autopilot_reply", [
      reply({
        message: "Yes, we design kitchens.",
        reason: "She asked what we do; the service list says kitchens.",
      }),
    ]);
    await tick();
    expect(await leadIn(admin, run, meera)).toMatchObject({
      state: "writing",
      draft: { text: "Yes, we design kitchens.", kind: "reply", templateName: null, marks: [] },
      thought: "She asked what we do; the service list says kitchens.",
      // When she last wrote: the run bar counts who replied from it.
      repliedAt: expect.any(String),
    });
  });

  it("a rep sees only their own leads' rows, words and thoughts; only the starter and admins may control", async () => {
    const mine = await lead("Meera Iyer", rep);
    const theirs = await lead("Rohan Gupta", other);
    const run = await start([mine, theirs], admin);
    await tick();
    const byRep = await get(rep, `/api/v1/autopilot/runs/${run}`);
    expect(byRep.leads.map((l: LeadView) => l.leadId)).toEqual([mine]);
    expect(JSON.stringify(byRep)).not.toContain("Rohan");
    expect(byRep.run.canControl).toBe(false);
    expect((await get(admin, `/api/v1/autopilot/runs/${run}`)).run.canControl).toBe(true);
    // Who it speaks as, by name: the person who started it here.
    expect((await get(admin, `/api/v1/autopilot/runs/${run}`)).run.speakerName).toBe(adminName);
    const own = await start([await lead("Sneha Reddy", rep)], rep);
    expect((await get(rep, `/api/v1/autopilot/runs/${own}`)).run.canControl).toBe(true);
  });

  it("the runs list says how many are running", async () => {
    const run = await start([await lead("Meera Iyer", admin)], admin);
    expect((await get(admin, "/api/v1/autopilot/runs")).running).toBe(1);
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/autopilot/runs/${run}/end` });
    expect((await get(admin, "/api/v1/autopilot/runs")).running).toBe(0);
  });
});
