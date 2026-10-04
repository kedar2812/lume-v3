import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { analyticsTick } from "./rollup";

let h: Harness;
const TZ = "Asia/Kolkata";
beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
});
afterAll(async () => h.close());

const dirty = async () =>
  (await h.queryAll<{ day: string }>("SELECT day::text FROM analytics_dirty_days ORDER BY day")).map(
    (r) => r.day,
  );
const arrived = async (day: string) =>
  (
    await h.queryAll<{ n: number }>(
      "SELECT coalesce(sum(arrived), 0)::int AS n FROM analytics_daily_cohort WHERE day = $1::date",
      [day],
    )
  )[0]!.n;

describe("past days a write changed are counted again (owner, 2026-10-05: an import of older leads)", () => {
  it("leads arriving with their own older enquiry dates mark those days; the analytics job counts them", async () => {
    await h.queryAll("DELETE FROM analytics_dirty_days");
    // An import's rows, inserted in one statement, enquired on two days in March.
    const one = await h.seedLead({ ownerId: null });
    await h.queryAll(
      `INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, name, created_at, lead_created_at)
       SELECT gen_random_uuid(), l.pipeline_id, l.stage_id, now(), 'Imported ' || g, now(),
              CASE WHEN g <= 3 THEN DATE '2026-03-10' ELSE DATE '2026-03-12' END
       FROM leads l, generate_series(1, 5) g WHERE l.id = $1`,
      [one],
    );
    expect(await dirty()).toEqual(["2026-03-10", "2026-03-12"]);
    expect(await arrived("2026-03-10")).toBe(0);
    await analyticsTick(h.pool, new Date(), 1, {});
    expect(await arrived("2026-03-10")).toBe(3);
    expect(await arrived("2026-03-12")).toBe(2);
    expect(await dirty()).toEqual([]);
  });

  it("a backdated win, a deletion or a moved enquiry date marks its days, old and new; other edits mark nothing", async () => {
    await h.queryAll("DELETE FROM analytics_dirty_days");
    const id = await h.seedLead({ ownerId: null });
    await h.queryAll("DELETE FROM analytics_dirty_days");
    await h.queryAll("UPDATE leads SET last_activity_at = now(), name = 'Renamed' WHERE id = $1", [id]);
    expect(await dirty()).toEqual([]);
    await h.queryAll("UPDATE leads SET lead_created_at = '2026-02-01' WHERE id = $1", [id]);
    await h.queryAll("UPDATE leads SET won_at = '2026-02-20T06:00:00Z', value = 900 WHERE id = $1", [id]);
    expect(await dirty()).toEqual(["2026-02-01", "2026-02-20"]);
    await h.queryAll("DELETE FROM analytics_dirty_days");
    await h.queryAll("UPDATE leads SET lead_created_at = '2026-02-03' WHERE id = $1", [id]);
    expect(await dirty()).toEqual(["2026-02-01", "2026-02-03", "2026-02-20"]);
    await h.queryAll("DELETE FROM analytics_dirty_days");
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [id]);
    expect(await dirty()).toEqual(["2026-02-03", "2026-02-20"]);
  });

  it("the app can't write the list itself; it can only claim days through the job's function", async () => {
    await expect(
      h.pool.query("INSERT INTO analytics_dirty_days (day) VALUES ('2026-01-01')"),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("Analytics' Refresh: recount now (owner, 2026-10-05)", () => {
  it("recounts today, yesterday and any changed past day at once; a second press within a minute answers with that count", async () => {
    const admin = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "analytics.view", scope: "all" },
          { key: "leads.view", scope: "all" },
        ],
      }),
    );
    await h.queryAll("DELETE FROM analytics_dirty_days");
    await h.queryAll("DELETE FROM analytics_now_counted");
    const id = await h.seedLead({ ownerId: null });
    await h.queryAll("UPDATE leads SET lead_created_at = '2026-01-15' WHERE id = $1", [id]);
    expect(await dirty()).toEqual(["2026-01-15"]);
    const first = await admin.inject({ method: "POST", url: "/api/v1/analytics/refresh" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ recounted: true });
    expect(Date.parse(first.json().countedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await arrived("2026-01-15")).toBe(1);
    expect(await dirty()).toEqual([]);
    const second = await admin.inject({ method: "POST", url: "/api/v1/analytics/refresh" });
    expect(second.json()).toEqual({ recounted: false, countedAt: first.json().countedAt });
  });

  it("someone without analytics can't make it recount", async () => {
    const plain = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    const r = await plain.inject({ method: "POST", url: "/api/v1/analytics/refresh" });
    expect(r.statusCode).toBe(403);
  });
});
