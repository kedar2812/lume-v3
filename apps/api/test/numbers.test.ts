import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsTick } from "../src/modules/analytics/rollup";
import { createHarness, type AuthedClient, type Harness } from "./harness";

/**
 * Owner, 2026-10-05: "i added 12k leads from a csv file … the numbers are not matching up everywhere". After an
 * import-sized write of leads with their own enquiry dates, every place that counts them says the same thing: the
 * sidebar's views, the Leads counts and stage strip, Today's "no one yet", and Analytics (once its job has run).
 */
let h: Harness;
let admin: AuthedClient;
let pipelineId: string;
const TZ = "Asia/Kolkata";
const N = 500;
const TODAY_N = 7;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  // The real clock: the Leads list counts "today" from the database's now, and Analytics from the API's clock.
  h.clock.now = new Date();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(me);
  pipelineId = (await h.config()).pipelineId;
  const seed = await h.seedLead({ ownerId: null, name: "Seed" });
  // One statement, as an import's batch: 7 enquired today, the rest over the last 300 days; every other one unowned.
  await h.queryAll(
    `INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, owner_id, name, created_at, lead_created_at)
     SELECT gen_random_uuid(), l.pipeline_id, l.stage_id, now(), CASE WHEN g % 2 = 0 THEN $3::uuid END, 'Imported ' || g, now(),
            CASE WHEN g <= $2 THEN (now() AT TIME ZONE $4)::date ELSE (now() AT TIME ZONE $4)::date - (2 + g % 298) END
     FROM leads l, generate_series(1, $1) g WHERE l.id = $5`,
    [N, TODAY_N, me.id, TZ, seed],
  );
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [seed]);
  // The analytics job's next minutes: today and yesterday, then every marked past day.
  for (let i = 0; i < 12; i++) await analyticsTick(h.pool, h.clock.now, i * 10, {});
});
afterAll(async () => h.close());

const get = async (url: string) => {
  const r = await admin.inject({ method: "GET", url });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  return r.json();
};

describe("after an import, every number agrees (owner, 2026-10-05)", () => {
  it("New today: the sidebar view, the Leads count for it, and Analytics' today", async () => {
    // The preset view, with the preset's own filter (packages/core leads/presets.ts).
    const made = await admin.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "New today", color: "accent", filters: { createdDays: "1" } },
    });
    expect(made.statusCode, made.body).toBe(201);
    const newToday = made.json().view ?? made.json();
    const counts = (await get("/api/v1/views/counts")).counts as Record<string, number>;
    const leads = await get(`/api/v1/leads/counts?pipelineId=${pipelineId}&createdDays=1`);
    const analytics = await get("/api/v1/analytics/overview?range=today");
    const tile = analytics.tiles.find((t: { id: string }) => t.id === "new_leads").value;
    expect([counts[newToday.id], leads.total, tile]).toEqual([TODAY_N, TODAY_N, TODAY_N]);
  });

  it("everyone's leads: the Leads total, the stage strip and Analytics over the same days", async () => {
    const leads = await get(`/api/v1/leads/counts?pipelineId=${pipelineId}`);
    const strip = Object.values(leads.counts as Record<string, number>).reduce((a, n) => a + n, 0);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(h.clock.now);
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
      new Date(h.clock.now.getTime() - 330 * 86_400_000),
    );
    const analytics = await get(`/api/v1/analytics/overview?range=custom&from=${from}&to=${today}`);
    const tile = analytics.tiles.find((t: { id: string }) => t.id === "new_leads").value;
    expect([leads.total, strip, tile]).toEqual([N, N, N]);
  });

  it("no one yet: Today's count and the Leads count of unowned leads in open stages", async () => {
    const t = await get("/api/v1/today");
    const stages = (await get("/api/v1/pipelines")).pipelines.flatMap(
      (p: { stages: { id: string; kind: string }[] }) =>
        p.stages.filter((s) => s.kind === "open").map((s) => s.id),
    );
    const unowned = await get(
      `/api/v1/leads/counts?pipelineId=${pipelineId}&ownerId=none&stageId=${stages.join(",")}`,
    );
    expect(t.needsYou.unassigned).toBe(unowned.total);
    expect(unowned.total).toBe(N / 2);
  });
});
