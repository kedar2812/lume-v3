import { ALL_GRANTS, AUTOPILOT_PRESETS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/** Starting LUME AI on leads (Autopilot A2, Task 5; spec 2026-10-19 §1.1–§1.4, §3 "one run per lead"). */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let viewer: U;
let goal: string;
let numberId: string;
const licence = testLicence({ instanceId: "LUME-TEST-AUTOPILOT", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: U) => h.signIn(u);
const post = async (u: U, url: string, payload: unknown) =>
  (await as(u)).inject({ method: "POST", url, payload: payload as object });
const body = (leadIds: string[], o: Record<string, unknown> = {}) => ({
  leadIds,
  goal: { kind: "stage", stageId: goal },
  speakerId: null,
  permissions: AUTOPILOT_PRESETS.balanced,
  followUpDays: [2, 5],
  dailyCap: null,
  remember: false,
  ...o,
});
const lead = (name: string, o: { owner?: string; phone?: string | null } = {}) =>
  h.seedLead({
    ownerId: o.owner ?? rep.id,
    name,
    ...(o.phone === null
      ? {}
      : { phone: o.phone ?? `+9198765${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}` }),
  });
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
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
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
  // A run starts conversations with an approved template (A3: no template, no run).
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
});

describe("estimate and start", () => {
  it("the estimate counts, skips with why, costs and shares the month", async () => {
    const a = await lead("Meera Iyer");
    const b = await lead("Rohan Gupta");
    const none = await lead("No Number", { phone: null });
    const stop = await lead("Said Stop");
    await post(admin, `/api/v1/leads/${stop}/do-not-contact`, { reason: "Asked on a call" });
    const r = await post(admin, "/api/v1/autopilot/estimate", body([a, b, none, stop]));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      eligible: 2,
      skipped: [
        { leadId: none, why: "No WhatsApp number" },
        { leadId: stop, why: "Asked not to be messaged" },
      ],
      firstMessages: 2,
      metaCost: { amount: expect.any(Number), currency: "INR" },
      monthShare: 0.002,
    });
  });

  it("a run starts with the business's own goal and permissions, as the person starting it", async () => {
    const a = await lead("Meera Iyer");
    const b = await lead("Rohan Gupta");
    const perms = { ...AUTOPILOT_PRESETS.careful, send_files: "never" };
    const r = await post(rep, "/api/v1/autopilot/runs", body([a, b], { permissions: perms, dailyCap: 40 }));
    expect(r.statusCode).toBe(201);
    const { run, skipped } = r.json();
    expect(skipped).toEqual([]);
    // How many it took, for the island's "LUME AI is on 1 of 2" (A3).
    expect(r.json().leads).toBe(2);
    expect(run).toMatchObject({
      status: "running",
      startedBy: rep.id,
      speakerId: rep.id,
      numberId,
      goal: { kind: "stage", stageId: goal },
      // Booking needs a calendar LUME can book into (A3): Never, whatever was chosen.
      permissions: { ...perms, book_meetings: "never" },
      followUpDays: [2, 5],
      dailyCap: 40,
    });
    const read = (
      await (await as(rep)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run.id}` })
    ).json();
    expect(read.leads.map((l: { leadId: string; state: string }) => [l.leadId, l.state]).sort()).toEqual(
      [
        [a, "up_next"],
        [b, "up_next"],
      ].sort(),
    );
    expect(read.counts.up_next).toBe(2);
  });

  it("one run per lead, at once", async () => {
    const leads = await Promise.all(["A", "B", "C", "D"].map((n) => lead(`Lead ${n}`)));
    const [one, two] = await Promise.all([
      post(admin, "/api/v1/autopilot/runs", body(leads.slice(0, 3))),
      post(admin, "/api/v1/autopilot/runs", body(leads.slice(1))),
    ]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    const rows = await h.queryAll<{ lead_id: string; n: string }>(
      "SELECT lead_id, count(*) AS n FROM autopilot_leads WHERE active GROUP BY lead_id",
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => Number(x.n) === 1)).toBe(true);
    const skipped = [...one.json().skipped, ...two.json().skipped];
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s: { why: string }) => s.why === "Already in another LUME AI run")).toBe(true);
  });

  it("refusals in words: LUME AI off, its month used up, the number rated yellow, a speaker who can't message", async () => {
    const a = await lead("Meera Iyer");
    const start = (o: Record<string, unknown> = {}) => post(admin, "/api/v1/autopilot/runs", body([a], o));

    await h.ownerPool.query("UPDATE whatsapp_numbers SET quality = 'yellow' WHERE id = $1", [numberId]);
    const yellow = await start();
    expect(yellow.statusCode).toBe(409);
    expect(yellow.json().error.message).toBe(
      "WhatsApp rated +91 90000 00001 yellow. LUME AI waits until it recovers, to protect the number.",
    );
    await h.ownerPool.query("UPDATE whatsapp_numbers SET quality = 'green' WHERE id = $1", [numberId]);

    const mute = await start({ speakerId: viewer.id });
    expect(mute.statusCode).toBe(400);
    expect(mute.json().error.message).toBe("LUME AI can only speak as someone who may send messages.");

    licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1 });
    await checkIn();
    await h.queryAll(
      "INSERT INTO ai_reads (id, lead_id, user_id, task, provider, model, status, created_at) VALUES (gen_random_uuid(), $1, $2, 'catch_up', 'fake', 'fake-1', 'ok', $3)",
      [a, admin.id, h.clock.now],
    );
    const month = await start();
    expect(month.statusCode).toBe(409);
    expect(month.json().error.message).toBe(
      "LUME AI has used this month's allowance. Ask for a top-up from LUME AI's ring.",
    );

    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    const off = await start();
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toBe(
      "LUME AI is off. An admin can switch it on in Settings → Integrations.",
    );
  });

  it("a rep sees only their own leads' rows; someone who can't message many leads can't start", async () => {
    const mine = await lead("Mine");
    const theirs = await lead("Theirs", { owner: admin.id });
    const run = (await post(admin, "/api/v1/autopilot/runs", body([mine, theirs]))).json().run;
    const seen = (
      await (await as(rep)).inject({ method: "GET", url: `/api/v1/autopilot/runs/${run.id}` })
    ).json();
    expect(seen.leads.map((l: { leadId: string }) => l.leadId)).toEqual([mine]);
    expect((await post(viewer, "/api/v1/autopilot/runs", body([mine]))).statusCode).toBe(403);
  });

  it("remember saves the standing choices for an admin only", async () => {
    const a = await lead("Meera Iyer");
    const perms = { ...AUTOPILOT_PRESETS.careful, mark_lost: "ask" };
    const r = await post(admin, "/api/v1/autopilot/runs", body([a], { permissions: perms, remember: true }));
    expect(r.json().remembered).toBe(true);
    const saved = (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai/profile" })).json()
      .profile;
    expect(saved.standing.permissions).toEqual(perms);
    const b = await lead("Rohan Gupta");
    const byRep = await post(rep, "/api/v1/autopilot/runs", body([b], { remember: true, followUpDays: [3] }));
    expect(byRep.json().remembered).toBe(false);
    expect(
      (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai/profile" })).json().profile.standing
        .followUpDays,
    ).toEqual([2, 5]);
  });
});
