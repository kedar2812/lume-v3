import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * Recommended by LUME AI (owner, 2026-10-31): outside WhatsApp's 24 hours, LUME AI picks the approved template that
 * fits this lead best and says why in one line. Only ever one the person could send; nothing when LUME AI is off.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let viewer: U;
const licence = testLicence({ instanceId: "LUME-TEST-RECOMMEND", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: U) => h.signIn(u);
const put = async (u: U, url: string, payload: unknown) =>
  (await as(u)).inject({ method: "PUT", url, payload: payload as object });
const recommend = async (u: U, lead: string) =>
  (await as(u)).inject({ method: "POST", url: `/api/v1/leads/${lead}/whatsapp/templates/recommend` });
// Row security is forced on ai_reads: read them as the harness's all-scope query.
const reads = async () =>
  (await h.queryAll<{ task: string }>("SELECT task FROM ai_reads ORDER BY created_at")).map((r) => r.task);
const lead = (name = "Mrunal Desai") =>
  h.seedLead({
    ownerId: rep.id,
    name,
    phone: `+9198765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`,
  });

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
  viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
  await seedNumber(h, { runAs: admin.id });
  await put(admin, "/api/v1/integrations/ai", { enabled: true });
  await put(admin, "/api/v1/integrations/whatsapp", { replyFromLume: true });
});

describe("POST /api/v1/leads/:id/whatsapp/templates/recommend", () => {
  it("LUME AI picks the approved template that fits this lead, and says why in one line", async () => {
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
    const call = await approvedTemplate(
      h,
      meta,
      admin,
      "Hi {{lead.first_name}}, would a short call this week suit you?",
    );
    provider.script("autopilot_first", [{ templateId: call, why: "Mrunal asked how it works: a call shows it best." }]);
    const l = await lead();
    const state = await (await as(rep)).inject({ method: "GET", url: `/api/v1/leads/${l}/whatsapp/templates` });
    expect(state.json().options?.length, state.body).toBe(2);
    const r = await recommend(rep, l);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      pick: { submissionId: call, why: "Mrunal asked how it works: a call shows it best." },
    });
    expect(await reads()).toEqual(["autopilot_first"]);
  });

  it("with one template that fits, LUME AI still reads the lead, so the why is about them", async () => {
    const only = await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry.");
    provider.script("autopilot_first", [{ templateId: only, why: "A warm hello suits a first message." }]);
    expect((await recommend(rep, await lead())).json()).toEqual({
      pick: { submissionId: only, why: "A warm hello suits a first message." },
    });
  });

  it("an answer naming a template the person couldn't send is no recommendation", async () => {
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry.");
    provider.script("autopilot_first", [{ templateId: newId(), why: "Made up." }]);
    expect((await recommend(rep, await lead())).json()).toEqual({ pick: null });
  });

  it("a template the lead lacks a value for is never offered to LUME AI; none left, no read at all", async () => {
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, your call is on {{meeting.date}}.");
    expect((await recommend(rep, await lead())).json()).toEqual({ pick: null });
    expect(await reads()).toEqual([]);
  });

  it("LUME AI off: no recommendation, and nothing is read", async () => {
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry.");
    await put(admin, "/api/v1/integrations/ai", { enabled: false });
    expect((await recommend(rep, await lead())).json()).toEqual({ pick: null });
    expect(await reads()).toEqual([]);
  });

  it("someone who can't message the lead gets nothing, and nothing is read", async () => {
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry.");
    expect((await recommend(viewer, await lead())).statusCode).toBe(403);
    expect(await reads()).toEqual([]);
  });
});
