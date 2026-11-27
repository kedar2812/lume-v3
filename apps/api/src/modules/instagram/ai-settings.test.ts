import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";

/**
 * Settings for LUME AI on Instagram (plan 2026-11-27-instagram-lume-ai, Task 4): each account's "Who answers new DMs",
 * off with the reason while LUME AI can't answer; what LUME AI aims for; and a flow's Hand to LUME AI publishable only
 * where LUME AI answers Instagram.
 */
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
const licence = testLicence({ instanceId: "LUME-TEST-IG-AISET", now: () => h.clock.now });
const provider = fakeProvider();
const as = () => h.signIn(admin);
const ai = async (enabled: boolean) =>
  (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled } });
const patch = async (payload: object) =>
  (await as()).inject({ method: "PATCH", url: `/api/v1/instagram/accounts/${account.id}`, payload });
const view = async () =>
  (await (await as()).inject({ method: "GET", url: "/api/v1/instagram/accounts" })).json();

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
    ai: { read: (r) => provider.read(r), name: "fake", model: "fake-1" },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-23T08:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(24 * 3_600_000);
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query("TRUNCATE instagram_flows CASCADE");
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.ownerPool.query(
    "UPDATE settings SET integrations = integrations #- '{instagram,aiGoal}' WHERE id = 1",
  );
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as()).inject({ method: "POST", url: "/api/v1/licence/check" });
  account = await seedIgAccount(h, { runAs: admin.id, owner: admin.id });
  await ai(true);
});

describe("Who answers new DMs", () => {
  it("Your team by default; LUME AI once chosen, said in the audit log", async () => {
    expect((await view()).accounts[0].newDms).toBe("team");
    expect((await view()).ai).toMatchObject({ ok: true });
    const r = await patch({ newDms: "ai" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().accounts[0].newDms).toBe("ai");
    const [log] = await h.queryAll<{ diff: { newDms?: unknown } }>(
      "SELECT diff FROM audit_log WHERE action = 'instagram.updated' ORDER BY id DESC LIMIT 1",
    );
    expect(log!.diff.newDms).toEqual({ from: "team", to: "ai" });
  });

  it("LUME AI switched off: the choice is refused with why, and the card is told why", async () => {
    await ai(false);
    const r = await patch({ newDms: "ai" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "AI_UNAVAILABLE",
      message: "LUME AI is switched off. An admin can switch it on in Settings → Integrations.",
    });
    expect((await view()).ai).toMatchObject({ ok: false, why: expect.stringContaining("switched off") });
    // Back to the team is always allowed.
    expect((await patch({ newDms: "team" })).statusCode).toBe(200);
  });
});

describe("what LUME AI aims for on Instagram", () => {
  it("a default until set; a written goal or an open stage; the standing run takes it", async () => {
    expect((await view()).ai.goal).toMatchObject({ kind: "brief" });
    const run = randomUUID();
    await h.queryAll(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, channel, instagram_account_id, standing, goal,
                                   permissions, follow_up_days, outside_hours)
       VALUES ($1, 'New DMs on @harbour.studio', $2, $2, 'instagram', $3, true, '{"kind":"brief","text":"x"}', '{}', '{}',
               'reply_any_time')`,
      [run, admin.id, account.id],
    );
    const put = async (goal: object) =>
      (await as()).inject({ method: "PUT", url: "/api/v1/instagram/ai-goal", payload: { goal } });
    expect((await put({ kind: "brief", text: "  Book a trial class  " })).statusCode).toBe(200);
    expect((await view()).ai.goal).toEqual({ kind: "brief", text: "Book a trial class" });
    const [r] = await h.queryAll<{ goal: unknown }>("SELECT goal FROM autopilot_runs WHERE id = $1", [run]);
    expect(r!.goal).toEqual({ kind: "brief", text: "Book a trial class" });
    expect((await put({ kind: "brief", text: "   " })).json().error.code).toBe("GOAL_REQUIRED");
    expect((await put({ kind: "stage", stageId: randomUUID() })).json().error.code).toBe("STAGE_INVALID");
    const cfg = await h.config();
    expect((await put({ kind: "stage", stageId: cfg.stages.New })).statusCode).toBe(200);
  });
});

describe("a flow's Hand to LUME AI", () => {
  const steps = [
    { id: "ai", type: "handoff", to: "ai", goal: { kind: "brief", text: "Book a trial class" } },
  ];
  const flow = async () => {
    const r = await (
      await as()
    ).inject({ method: "POST", url: "/api/v1/instagram/flows", payload: { name: "Trial" } });
    expect(r.statusCode, r.body).toBe(201);
    const f = r.json();
    const saved = await (
      await as()
    ).inject({ method: "PUT", url: `/api/v1/instagram/flows/${f.id}`, payload: { rev: f.rev, steps } });
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json();
  };

  it("checks clean where LUME AI answers Instagram; says why not where it doesn't", async () => {
    const f = await flow();
    expect(f.problems).not.toContain(
      "LUME AI isn't answering Instagram in this LUME yet. Hand to a person for now.",
    );
    await ai(false);
    const again = (
      await (await as()).inject({ method: "GET", url: `/api/v1/instagram/flows/${f.id}` })
    ).json();
    expect(again.problems).toContain(
      "LUME AI isn't answering Instagram in this LUME yet. Hand to a person for now.",
    );
  });
});
