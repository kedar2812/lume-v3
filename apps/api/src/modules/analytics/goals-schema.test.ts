import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const goal = (
  o: Partial<Record<"scope" | "scope_id" | "metric" | "period" | "period_start" | "target", unknown>> = {},
) => {
  const g = {
    scope: "business",
    scope_id: null,
    metric: "won",
    period: "month",
    period_start: "2026-10-01",
    target: 40,
    ...o,
  };
  return h.ownerPool.query(
    "INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)",
    [g.scope, g.scope_id, g.metric, g.period, g.period_start, g.target],
  );
};

describe("goals, spend and suggestion cooldowns (8A Task 2)", () => {
  it("one goal per metric, period and who it's for; targets above zero; known metrics only", async () => {
    await goal({ period_start: "2026-11-01" });
    await expect(goal({ period_start: "2026-11-01" })).rejects.toThrow(/goals_one/);
    await expect(goal({ period_start: "2026-12-01", target: 0 })).rejects.toThrow(/check/i);
    await expect(goal({ period_start: "2026-12-01", metric: "vibes" })).rejects.toThrow(/check/i);
    // A person's goal names the person; the business's names no one.
    await expect(goal({ period_start: "2026-12-01", scope: "user" })).rejects.toThrow(/check/i);
    const u = await h.seedUser({ grants: [] });
    await goal({ period_start: "2026-12-01", scope: "user", scope_id: u.id });
    await goal({
      period_start: "2026-12-01",
      scope: "user",
      scope_id: (await h.seedUser({ grants: [] })).id,
    });
  });

  it("a source's monthly spend is never negative", async () => {
    const [src] = (await h.ownerPool.query("SELECT id FROM lead_sources LIMIT 1")).rows;
    if (!src) return;
    await expect(
      h.ownerPool.query("UPDATE lead_sources SET monthly_spend = -1 WHERE id = $1", [src.id]),
    ).rejects.toThrow(/check/i);
    await h.ownerPool.query("UPDATE lead_sources SET monthly_spend = 12000 WHERE id = $1", [src.id]);
  });

  it("the app may keep goals and cooldowns; the worker role can't read them", async () => {
    expect((await h.pool.query("SELECT count(*)::int n FROM goals")).rows[0].n).toBeGreaterThanOrEqual(0);
    expect((await h.pool.query("SELECT count(*)::int n FROM analytics_insight_seen")).rows[0].n).toBe(0);
    const worker = new pg.Pool({ connectionString: h.url("lume_worker"), max: 1 });
    await expect(worker.query("SELECT 1 FROM goals")).rejects.toThrow(/permission denied/);
    await expect(worker.query("SELECT 1 FROM analytics_insight_seen")).rejects.toThrow(/permission denied/);
    await worker.end();
  });
});
