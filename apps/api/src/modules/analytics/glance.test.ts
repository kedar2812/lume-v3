import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, MAY, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let plain: SeededUser;
let rep: SeededUser;
const TZ = "Asia/Kolkata";

beforeAll(async () => {
  h = await createHarness();
  // June 20, 15:30 in Kolkata: the week is June 14–20, the one before June 7–13; the month is June 1–20.
  h.clock.now = new Date("2026-06-20T10:00:00Z");
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  plain = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
  rep = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
  // This week: 5 leads (3 contacted, 2 replied), 2 calls booked; the week before: 2 leads. Wins in June and May.
  for (let i = 0; i < 5; i++) {
    const id = await s.lead({ owner: i < 2 ? rep.id : admin.id, at: at(6, 14 + i) });
    if (i < 3) await s.contact(id, at(6, 14 + i), 20, i < 2);
    if (i < 2)
      await s.meeting({
        lead: id,
        owner: admin.id,
        startsAt: at(6, 25),
        status: "scheduled",
        createdAt: at(6, 15 + i),
      });
  }
  for (let i = 0; i < 2; i++) await s.lead({ owner: admin.id, at: at(6, 8 + i) });
  await s.lead({ owner: admin.id, at: at(5, 20), wonAt: at(6, 3), value: 1000 });
  await s.lead({ owner: admin.id, at: at(5, 20), wonAt: at(6, 18), value: 500 });
  await s.lead({ owner: admin.id, at: at(4, 20), wonAt: at(5, 10), value: 900 });
  await rollupDays(h.pool, [...MAY, ...JUNE], TZ);
});
afterAll(async () => h.close());

type Kpi = {
  id: string;
  value: number | null;
  previous: number | null;
  series: (number | null)[];
  period: string;
};
const get = async (u: SeededUser, path: string) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/${path}` })).json();

describe("Today's quick stats (owner, 2026-10-05: Today per frontend spec §8.2)", () => {
  it("are the Overview's own numbers: the last 7 days against the 7 before, revenue this month against last", async () => {
    const g = await get(admin, "glance");
    const k = (id: string) => (g.kpis as Kpi[]).find((x) => x.id === id)!;
    const week = await get(admin, "overview?range=7d&compare=1");
    const month = await get(admin, "overview?range=this_month&compare=1");
    const tile = (
      o: { tiles: { id: string; value: number | null; previous: number | null }[] },
      id: string,
    ) => o.tiles.find((t) => t.id === id)!;
    for (const id of ["new_leads", "reply_rate", "calls_booked"]) {
      expect([id, k(id).value, k(id).previous]).toEqual([id, tile(week, id).value, tile(week, id).previous]);
      expect(k(id).series).toHaveLength(7);
      // Today's daily line is the Analytics tile's own (a day with nobody to divide by is a gap, not a 0%).
      expect([id, k(id).series]).toEqual([id, week.series.tiles[id]]);
    }
    expect(k("new_leads")).toMatchObject({ value: 5, previous: 2, period: "week" });
    expect(k("new_leads").series).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(k("reply_rate").value).toBeCloseTo(2 / 3, 6);
    expect(k("calls_booked").value).toBe(2);
    expect(k("revenue_won")).toMatchObject({
      value: tile(month, "revenue_won").value,
      previous: tile(month, "revenue_won").previous,
    });
    expect(k("revenue_won").value).toBe(1500);
    // Revenue climbs through the month: June 3 brings 1,000, June 18 another 500.
    expect(k("revenue_won").series.at(-1)).toBe(1500);
    expect(k("revenue_won").series[1]).toBe(0);
    expect(k("revenue_won").series[2]).toBe(1000);
  });

  it("no money without the revenue permission; a rep's are their own", async () => {
    expect((await get(plain, "glance")).kpis.map((x: Kpi) => x.id)).toEqual([
      "new_leads",
      "reply_rate",
      "calls_booked",
    ]);
    const mine = (await get(rep, "glance")).kpis as Kpi[];
    expect(mine.find((x) => x.id === "new_leads")!.value).toBe(2);
  });
});
