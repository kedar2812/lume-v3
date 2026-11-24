import {
  ALL_GRANTS,
  applyOps,
  blocking,
  toGraph,
  validateGraph,
  type FlowGraph,
  type GraphOp,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";

/** LUME AI builds a flow (plan 2026-11-23-flow-builder, Task C1): POST /api/v1/instagram/flows/:id/ai-build. */
let h: Harness;
let ig: InstagramFake;
type U = { id: string; email: string; password: string };
let admin: U;
const licence = testLicence({ instanceId: "LUME-TEST-FLOW-AI", now: () => h.clock.now });
const provider = fakeProvider();

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(admin)).inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
const newFlow = async () => (await call("POST", "/api/v1/instagram/flows", { name: "Prices" })).json();
const build = (id: string, body: Record<string, unknown>) =>
  call("POST", `/api/v1/instagram/flows/${id}/ai-build`, body);
const reads = () =>
  h.queryAll<{ task: string; lead_id: string | null; status: string }>(
    "SELECT task, lead_id, status FROM ai_reads ORDER BY created_at",
  );
const step = (o: Record<string, unknown>) => ({
  text: "",
  links: [],
  options: [],
  weights: [],
  next: null,
  otherwise: null,
  save: null,
  retry: "",
  minutes: 0,
  match: "all",
  rules: [],
  changes: [],
  to: "owner",
  url: "",
  ...o,
});
const answer = (steps: unknown[]) => ({ plan: ["Do it"], said: "Done.", start: "a", steps });

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    licence: licence.options,
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices, instagram_flows, leads CASCADE");
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await call("POST", "/api/v1/licence/check");
  await call("PUT", "/api/v1/integrations/ai", { enabled: true });
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  await seedIgAccount(h, { runAs: admin.id });
});

describe("POST /api/v1/instagram/flows/:id/ai-build", () => {
  it("answers with steps that, played into the draft, pass the checks; saves nothing; one read about no lead", async () => {
    const f = await newFlow();
    const r = await build(f.id, { prompt: "Send the price list, or hand to the team" });
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json() as { plan: string[]; said: string; ops: GraphOp[]; refused: boolean };
    expect(out.refused).toBe(false);
    expect(out.plan.length).toBeGreaterThan(0);
    const played: FlowGraph = applyOps(toGraph(f.draft), out.ops);
    expect(played.nodes.map((n) => n.type)).toEqual(["message", "message", "handoff"]);
    expect(blocking(validateGraph(played, { ai: false }))).toEqual([]);
    // The draft is the builder's to save, against its rev: nothing written here.
    const after = (await call("GET", `/api/v1/instagram/flows/${f.id}`)).json();
    expect(after.rev).toBe(f.rev);
    expect(after.draft).toEqual(f.draft);
    expect(await reads()).toEqual([{ task: "flow_build", lead_id: null, status: "ok" }]);
    const audits = await h.queryAll<{ action: string; entity_id: string; diff: Record<string, unknown> }>(
      "SELECT action, entity_id, diff FROM audit_log WHERE action = 'instagram.flow.ai'",
    );
    expect(audits).toEqual([
      {
        action: "instagram.flow.ai",
        entity_id: f.id,
        diff: { steps: 3, ops: expect.any(Number), refused: false },
      },
    ]);
  });

  it("a fourth button is left off and said; a message too long for Instagram is refused with no steps", async () => {
    const f = await newFlow();
    const links = [1, 2, 3, 4].map((i) => ({ title: `Link ${i}`, url: `https://palm.example/${i}` }));
    provider.script("flow_build", [
      answer([step({ id: "a", type: "message", text: "Pick one", links })]),
      answer([step({ id: "a", type: "message", text: "x".repeat(1200) })]),
    ]);
    const fixed = (await build(f.id, { prompt: "Four links" })).json();
    expect(fixed.said).toContain("Instagram allows 3 buttons on a message, so LUME kept the first 3.");
    const added = (fixed.ops as GraphOp[]).find((o) => o.op === "add");
    expect(added?.op === "add" && added.node.type === "message" && added.node.buttons).toHaveLength(3);
    const refused = (await build(f.id, { prompt: "A long one" })).json();
    expect(refused).toMatchObject({ refused: true, ops: [] });
    expect(refused.said).toContain("Nothing changed.");
  });

  it("tells LUME AI the flow, its stages and tags, and nothing of any lead", async () => {
    await h.seedLead({ ownerId: admin.id, name: "Priya Shah", phone: "+919876543210" });
    const f = await newFlow();
    await build(f.id, { prompt: "Tag people who say yes", selection: ["not-a-step"] });
    const sent = provider.calls.at(-1)!;
    const input = JSON.parse(sent.input);
    expect(input.request).toBe("Tag people who say yes");
    expect(input.stages.length).toBeGreaterThan(0);
    expect(sent.input).not.toContain("Priya");
    expect(sent.input).not.toContain("9876543210");
    // A selection names steps in this flow; one that isn't there is dropped.
    expect(sent.instructions).not.toContain("not-a-step");
  });

  it("tells LUME AI only what a flow may use: no contact fields, nothing archived, no trigger that's off", async () => {
    const f = await newFlow();
    await h.ownerPool.query(
      `INSERT INTO field_definitions (id, key, label, type, archived_at) VALUES
         (gen_random_uuid(), 'goal_weight', 'Goal weight', 'number', NULL),
         (gen_random_uuid(), 'alt_phone', 'Other number', 'phone', NULL),
         (gen_random_uuid(), 'alt_mail', 'Other email', 'email', NULL),
         (gen_random_uuid(), 'old_note', 'Old note', 'text', now())`,
    );
    await h.ownerPool.query("UPDATE settings SET field_defs_version = field_defs_version + 1 WHERE id = 1");
    const [old] = await h.queryAll<{ id: string }>(
      `INSERT INTO stages (id, pipeline_id, name, kind, position, archived_at)
       SELECT gen_random_uuid(), id, 'Retired stage', 'open', 99, now() FROM pipelines LIMIT 1 RETURNING id`,
    );
    await h.ownerPool.query(
      `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, enabled) VALUES
         (gen_random_uuid(), $1, 'dm', '{price}', true), (gen_random_uuid(), $1, 'comment', '{oldword}', false)`,
      [f.id],
    );
    await build(f.id, { prompt: "Ask for their goal weight" });
    const sent = provider.calls.at(-1)!;
    const input = JSON.parse(sent.input) as { fields: { key: string }[]; stages: { id: string }[] };
    const keys = input.fields.map((x) => x.key);
    expect(keys).toContain("goal_weight");
    expect(keys).not.toContain("alt_phone");
    expect(keys).not.toContain("alt_mail");
    expect(keys).not.toContain("old_note");
    expect(input.stages.map((s) => s.id)).not.toContain(old!.id);
    expect(sent.instructions).toContain("A DM with price");
    expect(sent.instructions).not.toContain("oldword");
    await h.ownerPool.query(
      "DELETE FROM field_definitions WHERE key IN ('goal_weight', 'alt_phone', 'alt_mail', 'old_note')",
    );
    await h.ownerPool.query("DELETE FROM stages WHERE id = $1", [old!.id]);
    await h.ownerPool.query("UPDATE settings SET field_defs_version = field_defs_version + 1 WHERE id = 1");
  });

  it("past the hour's LUME AI limit, it says so and nothing changes", async () => {
    const f = await newFlow();
    licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: 1, aiCallsMonthly: 1000 });
    await call("POST", "/api/v1/licence/check");
    expect((await build(f.id, { prompt: "Prices" })).statusCode).toBe(200);
    const r = await build(f.id, { prompt: "Prices again" });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("AI_LIMIT");
    expect((await call("GET", `/api/v1/instagram/flows/${f.id}`)).json().rev).toBe(f.rev);
  });

  it("says why when it can't: no words, LUME AI off, or LUME AI failing; nothing changes", async () => {
    const f = await newFlow();
    expect((await build(f.id, { prompt: "   " })).json().error.code).toBe("EMPTY");
    await call("PUT", "/api/v1/integrations/ai", { enabled: false });
    expect((await build(f.id, { prompt: "Prices" })).json().error.code).toBe("AI_OFF");
    await call("PUT", "/api/v1/integrations/ai", { enabled: true });
    provider.script("flow_build", [{ not: "a flow" }]);
    const failed = await build(f.id, { prompt: "Prices" });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.message).toBe("LUME AI couldn't build this just now. Try again.");
    expect((await call("GET", `/api/v1/instagram/flows/${f.id}`)).json().rev).toBe(f.rev);
  });

  it("a flow that isn't there is said as missing", async () => {
    const r = await build("0190e0c0-0000-7000-8000-00000000dead", { prompt: "Prices" });
    expect(r.statusCode).toBe(404);
  });
});
