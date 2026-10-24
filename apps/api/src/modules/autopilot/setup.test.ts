import { ALL_GRANTS, AUTOPILOT_PRESETS, newId } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/** What the start sheet needs (Autopilot A3, Task 1; spec 2026-10-19 §1.1–§1.4): readiness, choices, what's usable. */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let viewer: U;
let goal: string;
const licence = testLicence({ instanceId: "LUME-TEST-AUTOPILOT-SETUP", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: U) => h.signIn(u);
const get = async (u: U, url: string) => (await as(u)).inject({ method: "GET", url });
const post = async (u: U, url: string, payload: unknown) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const put = async (u: U, url: string, payload: unknown) =>
  (await as(u)).inject({ method: "PUT", url, payload: payload as object });
const setup = async (u: U = admin) => {
  const r = await get(u, "/api/v1/autopilot/setup");
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const body = (o: Record<string, unknown> = {}) => ({
  goal: { kind: "stage", stageId: goal },
  speakerId: null,
  permissions: AUTOPILOT_PRESETS.hands_off,
  followUpDays: [2, 5],
  dailyCap: null,
  ...o,
});
const lead = (name: string) =>
  h.seedLead({
    ownerId: rep.id,
    name,
    phone: `+9198765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`,
  });
/** A fresh tag on these leads: a filter that matches exactly them (as the bulk runs' tests do). */
const tagged = async (ids: string[]) => {
  const tag = newId();
  await h.queryAll("INSERT INTO tags (id, label) VALUES ($1, $2)", [tag, `A ${tag.slice(-8)}`]);
  for (const id of ids)
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, tag]);
  return tag;
};
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
  viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: false });
  const { pipelineId } = await h.config();
  goal = (
    await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("DELETE FROM ai_profile");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("UPDATE lost_reasons SET archived_at = NULL");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await checkIn();
  await seedNumber(h, { runAs: admin.id });
  await put(admin, "/api/v1/integrations/ai", { enabled: true });
  await put(admin, "/api/v1/integrations/whatsapp", { replyFromLume: true });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
});

describe("GET /api/v1/autopilot/setup", () => {
  it("ready, with the business's goals, people, standing choices, hours and number", async () => {
    const s = await setup();
    expect(s.ready).toEqual({ ok: true });
    expect(s.goals.length).toBeGreaterThan(0);
    for (const g of s.goals)
      expect(g).toEqual({ kind: "stage", stageId: expect.any(String), name: expect.any(String) });
    expect(s.speakers.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([admin.id, rep.id]));
    expect(s.speakers.map((p: { id: string }) => p.id)).not.toContain(viewer.id);
    expect(s.standing).toEqual({
      permissions: AUTOPILOT_PRESETS.balanced,
      followUpDays: [2, 5],
      dailyCap: null,
      speaker: null,
    });
    expect(s.hours.line).toMatch(/\d (am|pm) to \d+(:\d\d)? (am|pm)$/);
    expect(s.number).toEqual({ display: "+91 90000 00001", tierLimit: null });
    expect(s.canRemember).toBe(true);
  });

  it("what the business can't use yet is off, with why and where to set it up", async () => {
    await h.ownerPool.query("UPDATE lost_reasons SET archived_at = now()");
    const { available } = await setup();
    expect(available.send_files).toEqual({
      ok: false,
      why: "Choose the files LUME AI may send in Settings → LUME AI.",
      fixHref: "/settings/ai",
    });
    expect(available.answer_prices).toEqual({
      ok: false,
      why: "Add your price list in Settings → LUME AI.",
      fixHref: "/settings/ai",
    });
    expect(available.mark_lost).toEqual({
      ok: false,
      why: "Add your lost reasons in Settings → Lists.",
      fixHref: "/settings/lists",
    });
    expect(available.book_meetings).toEqual({
      ok: false,
      why: "Needs a calendar LUME can book into.",
      fixHref: null,
    });
    for (const a of [
      "first_messages",
      "follow_ups",
      "replies",
      "move_stages",
      "set_follow_ups",
      "fill_fields",
      "hand_to_rep",
    ])
      expect(available[a]).toEqual({ ok: true });
  });

  it("each thing a run needs first is said in words, with where to fix it", async () => {
    await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
    expect((await setup()).ready).toEqual({
      ok: false,
      code: "NO_TEMPLATES",
      message: "LUME AI starts conversations with your approved WhatsApp templates. Submit one in Templates.",
      fixHref: "/templates",
    });
    await h.ownerPool.query("DELETE FROM whatsapp_numbers");
    expect((await setup()).ready).toMatchObject({
      ok: false,
      code: "NO_NUMBER",
      fixHref: "/settings/integrations/whatsapp",
    });
    await put(admin, "/api/v1/integrations/whatsapp", { replyFromLume: false });
    expect((await setup()).ready).toMatchObject({
      ok: false,
      code: "REPLY_OFF",
      fixHref: "/settings/integrations/whatsapp",
    });
    await put(admin, "/api/v1/integrations/ai", { enabled: false });
    expect((await setup()).ready).toEqual({
      ok: false,
      code: "AI_OFF",
      message: "LUME AI is off. An admin can switch it on in Settings → Integrations.",
      fixHref: "/settings/integrations",
    });
  });

  it("a rep may read it but not remember choices; someone who can't message many leads can't", async () => {
    expect((await setup(rep)).canRemember).toBe(false);
    expect((await get(viewer, "/api/v1/autopilot/setup")).statusCode).toBe(403);
  });
});

describe("starting with what the business can use", () => {
  it("an action the business can't use is stored as Never, whatever was sent", async () => {
    const a = await lead("Meera Iyer");
    const r = await post(admin, "/api/v1/autopilot/runs", body({ leadIds: [a] }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().run.permissions).toMatchObject({
      send_files: "never",
      answer_prices: "never",
      book_meetings: "never",
      replies: "go",
    });
  });

  it("Use these every time keeps the choice as made, ready for when it's set up; the run keeps Never", async () => {
    const a = await lead("Meera Iyer");
    const r = await post(admin, "/api/v1/autopilot/runs", body({ leadIds: [a], remember: true }));
    expect(r.json().run.permissions.send_files).toBe("never");
    const saved = (await get(admin, "/api/v1/ai/profile")).json().profile;
    expect(saved.standing.permissions.send_files).toBe("go");
  });

  it("no approved template: the run doesn't start, and says why", async () => {
    await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
    const a = await lead("Meera Iyer");
    const r = await post(admin, "/api/v1/autopilot/runs", body({ leadIds: [a] }));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("NO_TEMPLATES");
  });

  it("all that match a filter: resolved on the server, as bulk actions are", async () => {
    const a = await lead("Meera Iyer");
    const b = await lead("Rohan Gupta");
    const c = await lead("Sneha Reddy");
    const tag = await tagged([a, b, c]);
    const selection = { filters: { tagId: tag }, except: [c], expected: 3 };
    const est = await post(admin, "/api/v1/autopilot/estimate", body({ selection }));
    expect(est.json()).toMatchObject({ eligible: 2, skipped: [] });
    const r = await post(admin, "/api/v1/autopilot/runs", body({ selection }));
    expect(r.statusCode, r.body).toBe(201);
    const run = (await get(admin, `/api/v1/autopilot/runs/${r.json().run.id}`)).json();
    expect(run.leads.map((l: { leadId: string }) => l.leadId).sort()).toEqual([a, b].sort());
  });

  it("a run takes up to 500 leads; ids or a filter, never both", async () => {
    const many: string[] = [];
    for (let i = 0; i < 501; i++) many.push(await lead(`Lead ${i}`));
    const tag = await tagged(many);
    const r = await post(
      admin,
      "/api/v1/autopilot/runs",
      body({ selection: { filters: { tagId: tag }, except: [], expected: 501 } }),
    );
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "TOO_MANY",
      message: "A run takes up to 500 leads. Narrow the filter.",
    });
    const a = await lead("Meera Iyer");
    const both = await post(
      admin,
      "/api/v1/autopilot/runs",
      body({ leadIds: [a], selection: { filters: { tagId: tag }, except: [], expected: 1 } }),
    );
    expect(both.statusCode).toBe(400);
  });
});
