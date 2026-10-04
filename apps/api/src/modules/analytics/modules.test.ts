import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
let sourceId: string;

const lead = async (ownerId: string | null, createdAt: string, extra: Record<string, unknown> = {}) => {
  const id = await h.seedLead({ ownerId });
  const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 3}`);
  await h.queryAll(
    `UPDATE leads SET created_at = $2::timestamptz${sets.length ? ", " + sets.join(", ") : ""} WHERE id = $1`,
    [id, createdAt, ...Object.values(extra)],
  );
  return id;
};

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  sourceId = (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name, monthly_spend) VALUES (gen_random_uuid(), 'manual', 'Spring fair', 3043.75) RETURNING id",
    )
  ).rows[0].id;
  const [reason] = await h.queryAll<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 1");
  // Ten leads from the fair in June, two won (one worth 4,000); one lost with a reason; one with a number lacking a country.
  for (let i = 0; i < 10; i++)
    await lead(rep.id, `2026-06-${String(i + 1).padStart(2, "0")}T05:00:00Z`, {
      source_id: sourceId,
      ...(i < 2
        ? { won_at: `2026-06-${String(i + 12).padStart(2, "0")}T06:00:00Z`, value: i === 0 ? 4000 : null }
        : {}),
    });
  await lead(rep.id, "2026-06-03T05:00:00Z", { lost_at: "2026-06-20T06:00:00Z", lost_reason_id: reason!.id });
  await lead(admin.id, "2026-06-04T05:00:00Z", { phone_status: "needs_country" });
  const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

describe("analytics modules (8A Task 6)", () => {
  it("sources: leads, win rate, money and the month's spend spread over the range", async () => {
    const body = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })
    ).json();
    const fair = body.sources.find((s: { id: string }) => s.id === sourceId);
    expect(fair).toMatchObject({
      name: "Spring fair",
      leads: 10,
      won: 2,
      winRate: 0.2,
      revenue: 4000,
      tooFew: false,
    });
    // 3,043.75 a month over 30 days of an average 30.4375-day month: 3,000; ten leads, 300 each.
    expect(fair.spend).toBeCloseTo(3000, 6);
    expect(fair.costPerLead).toBeCloseTo(300, 6);
    expect(fair.returnPerSpent).toBeCloseTo(4000 / 3000, 6);
    expect(body.revenueByDay).toHaveLength(30);
  });

  it("lost: by reason with its share, the stage left, and nothing past a rep's reach", async () => {
    const body = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/lost?${Q}` })
    ).json();
    expect(body.total).toBe(1);
    expect(body.reasons[0]).toMatchObject({ n: 1, share: 1 });
    const mine = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/analytics/lost?${Q}` })
    ).json();
    expect(mine.total).toBe(1);
    const other = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
    expect(
      (await (await h.signIn(other)).inject({ method: "GET", url: `/api/v1/analytics/lost?${Q}` })).json()
        .total,
    ).toBe(0);
  });

  it("timing: arrivals by weekday and hour in the business's time; thin cells say too few", async () => {
    const body = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/timing?${Q}` })
    ).json();
    // 05:00 UTC is 10:30 in Kolkata: every lead arrived in the 10 o'clock hour.
    const total = body.arrivals.flat().reduce((a: number, b: number) => a + b, 0);
    expect(total).toBe(12);
    expect(body.arrivals.reduce((a: number, row: number[]) => a + row[10]!, 0)).toBe(12);
    expect(body.replies[1][10]).toMatchObject({ rate: null, tooFew: true });
  });

  it("quality and templates answer, the money only with analytics.revenue", async () => {
    const q = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/quality?${Q}` })
    ).json();
    expect(q.phoneNeedsCountry).toBe(1);
    const t = await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: `/api/v1/analytics/templates?${Q}` });
    expect(t.statusCode).toBe(200);
    expect(t.json().templates).toEqual([]);
    const plain = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
    const s = (
      await (await h.signIn(plain)).inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })
    ).json();
    expect(s.sources[0]).not.toHaveProperty("revenue");
    expect(s).not.toHaveProperty("revenueByDay");
  });
});
