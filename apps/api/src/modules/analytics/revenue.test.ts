import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let plain: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-04-01&to=2026-06-15";
const products: { id: string; name: string }[] = [];
// Wins: [month (1-based), day, value, product index or null]. Fifteen in all, one deleted below.
const WINS: [number, number, number | null, number | null][] = [
  [4, 3, 1000, 0],
  [4, 9, 2000, 1],
  [4, 15, 1500, 0],
  [4, 27, null, 2],
  [5, 2, 3000, 2],
  [5, 6, 1000, 0],
  [5, 11, 2500, 1],
  [5, 18, 4000, 2],
  [5, 22, 1000, null],
  [5, 29, 2000, 0],
  [6, 2, 3000, 1],
  [6, 5, 1000, 0],
  [6, 8, 2000, 2],
  [6, 11, 1500, 0],
  [6, 14, 2500, 1],
];
const MAY = 3000 + 1000 + 2500 + 4000 + 1000 + 2000;
const JUNE = 3000 + 1000 + 2000 + 1500 + 2500;

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = new Date("2026-06-15T06:00:00Z");
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  plain = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
  for (const name of ["Starter", "Growth", "Premium"]) {
    const id = randomUUID();
    await h.ownerPool.query("INSERT INTO products (id, name) VALUES ($1, $2)", [id, name]);
    products.push({ id, name });
  }
  for (const [m, d, value, p] of WINS) {
    const id = await h.seedLead({ ownerId: admin.id });
    const won = new Date(Date.UTC(2026, m - 1, d, 6));
    await h.queryAll(
      "UPDATE leads SET created_at = $2, won_at = $3, value = $4, product_id = $5 WHERE id = $1",
      [id, new Date(won.getTime() - 5 * 86_400_000), won, value, p === null ? null : products[p]!.id],
    );
  }
  // A deleted win in June, worth a lot: counted nowhere.
  const gone = await h.seedLead({ ownerId: admin.id });
  await h.queryAll(
    "UPDATE leads SET created_at = '2026-06-01T06:00:00Z', won_at = '2026-06-09T06:00:00Z', value = 90000, product_id = $2, deleted_at = now() WHERE id = $1",
    [gone, products[2]!.id],
  );
  await h.ownerPool.query(
    "INSERT INTO goals (id, scope, metric, period, period_start, target) VALUES (gen_random_uuid(), 'business', 'revenue', 'month', '2026-06-01', 20000)",
  );
  const days: string[] = [];
  for (let t = Date.UTC(2026, 2, 25); t <= Date.UTC(2026, 5, 15); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

const get = async (u: SeededUser, q = Q) =>
  (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/revenue?${q}` });

describe("revenue (8D-1 Task 5)", () => {
  it("by month: twelve months ending this one, each month's wins", async () => {
    const r = (await get(admin)).json();
    expect(r.byMonth).toHaveLength(12);
    expect(r.byMonth.at(-1)).toMatchObject({ month: "2026-06", value: JUNE, goal: 20000 });
    expect(r.byMonth.at(-2)).toMatchObject({ month: "2026-05", value: MAY, goal: null });
    expect(r.byMonth[0].month).toBe("2025-07");
  });

  it("this month: day by day, adding up, against the goal, with the pace labelled", async () => {
    const r = (await get(admin)).json();
    expect(r.thisMonth.days).toHaveLength(15);
    expect(r.thisMonth.cumulative.at(-1)).toBe(JUNE);
    expect(r.thisMonth.goal).toBe(20000);
    // Half of June gone: the pace is twice what's won so far.
    expect(r.thisMonth.paceEnd).toBeCloseTo(JUNE / (15 / 30), 6);
  });

  it("by package: deals, money and shares; the won without a package; each opens its leads", async () => {
    const r = (await get(admin)).json();
    const total = WINS.reduce((a, w) => a + (w[2] ?? 0), 0);
    expect(r.total).toBe(total);
    const shares = r.byProduct.reduce((a: number, p: { share: number }) => a + p.share, 0);
    expect(shares).toBeCloseTo(1, 6);
    const none = r.byProduct.find((p: { id: string | null }) => p.id === null);
    expect(none).toMatchObject({ name: "Won without a package", deals: 1, value: 1000 });
    const premium = r.byProduct.find((p: { name: string }) => p.name === "Premium");
    expect(premium).toMatchObject({ deals: 4, value: 3000 + 4000 + 2000 });
    const a = await h.signIn(admin);
    for (const p of r.byProduct) {
      const open = await a.inject({
        method: "GET",
        url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(p.drill)}`,
      });
      expect(open.json().total, p.name).toBe(p.deals);
    }
  });

  it("the deleted win's value appears nowhere", async () => {
    const r = (await get(admin)).json();
    expect(JSON.stringify(r)).not.toContain("90000");
  });

  it("without analytics.revenue the board is refused", async () => {
    expect((await get(plain)).statusCode).toBe(403);
  });
});
