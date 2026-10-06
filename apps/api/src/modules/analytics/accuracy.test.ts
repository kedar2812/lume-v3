import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayOf, METRICS, trend } from "@lume/core";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { FIXTURE_TZ, reference, script, seedFixture, type Fixture } from "../../../test/fixtures/analytics";
import { rollupDays } from "./rollup";

/**
 * The owner, 2026-10-05: "run some tests on the analytics and kpis and make sure they pull the data accurately and
 * that there are no errors in the calculations". The fixture business (test/fixtures/analytics.ts) is fully known;
 * its answers come from the script with plain arithmetic, never read back from LUME. fixture.test.ts proves the
 * Overview's tiles, each person's own, the drill counts and the 8D boards; this file proves the rest: the period
 * before (every trend), the Team board row by row, a rep's My numbers, the timing heatmap, goals and their pace,
 * and Today's tiles against Analytics.
 */
let h: Harness;
let fx: Fixture;
let admin: SeededUser;
const JUNE: [string, string] = ["2026-06-01", "2026-06-28"];
const MAY: [string, string] = ["2026-05-04", "2026-05-31"]; // the 28 days before JUNE
const TILES = [
  "new_leads",
  "contacted",
  "reply_rate",
  "speed_to_lead",
  "won",
  "win_rate",
  "revenue_won",
  "avg_deal",
  "lost",
  "ontime",
];

beforeAll(async () => {
  h = await createHarness();
  fx = await seedFixture(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  const days: string[] = [];
  for (let t = Date.UTC(2026, 3, 27); t <= Date.UTC(2026, 6, 15); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  await rollupDays(h.pool, days, FIXTURE_TZ);
}, 240_000);
afterAll(async () => h.close());

const get = async (who: SeededUser, path: string) => {
  const r = await (await h.signIn(who)).inject({ method: "GET", url: `/api/v1/${path}` });
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  return r.json();
};
const custom = ([from, to]: [string, string]) => `range=custom&from=${from}&to=${to}`;
/** Rates to 1e-9; counts and money exactly; null stays null. */
const same = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Number.isInteger(v) ? v : expect.closeTo(v, 9);

describe("the period before: every trend compares like with like", () => {
  it("each Overview tile's previous value is the 28 days before, counted the same way, and its trend follows the rule", async () => {
    const o = await get(admin, `analytics/overview?${custom(JUNE)}&compare=1`);
    const now = reference(...JUNE, null);
    const before = reference(...MAY, null);
    for (const id of TILES) {
      const t = o.tiles.find((x: { id: string }) => x.id === id);
      expect([id, t.value]).toEqual([id, same(now[id])]);
      expect([id, "previous", t.previous]).toEqual([id, "previous", same(before[id])]);
      // The chip says exactly what the owner's trend rule says for these two numbers.
      const m = METRICS[id as keyof typeof METRICS];
      const want =
        now[id] !== null && before[id] !== null
          ? trend(now[id]!, before[id]!, { kind: m.trendKind, good: m.good })
          : null;
      expect([id, t.trend]).toEqual([id, want]);
    }
  });
});

describe("the Team board: each person's row is that person's own numbers", () => {
  it("new leads, contact, replies, speed, wins, revenue and on-time, person by person", async () => {
    const t = await get(admin, `analytics/team?${custom(JUNE)}`);
    for (const [p, person] of fx.people.entries()) {
      const want = reference(...JUNE, p);
      const row = t.people.find((r: { id: string }) => r.id === person.id);
      expect(row, `person ${p}`).toBeDefined();
      expect([p, row.newLeads, row.won, row.revenueWon]).toEqual([
        p,
        want.new_leads,
        want.won,
        want.revenue_won,
      ]);
      expect([p, row.contacted, row.replyRate, row.ontime, row.speedToLead]).toEqual([
        p,
        same(want.contacted),
        same(want.reply_rate),
        same(want.ontime),
        same(want.speed_to_lead),
      ]);
    }
  });
  it("the rows add up to the business: everyone's new leads, wins and revenue", async () => {
    const t = await get(admin, `analytics/team?${custom(JUNE)}`);
    const all = reference(...JUNE, null);
    const sum = (k: string) => t.people.reduce((a: number, r: Record<string, number>) => a + (r[k] ?? 0), 0);
    expect(sum("newLeads")).toBe(all.new_leads);
    expect(sum("won")).toBe(all.won);
    expect(sum("revenueWon")).toBe(all.revenue_won);
  });
});

describe("My numbers: a rep sees exactly their own", () => {
  it("each tile on a rep's own board is the script's answer for that person", async () => {
    for (const p of [0, 2, 5]) {
      const me = await get(fx.people[p]!, `analytics/me?${custom(JUNE)}`);
      const want = reference(...JUNE, p);
      for (const t of me.tiles as { id: string; value: number | null }[])
        if (t.id in want) expect([p, t.id, t.value]).toEqual([p, t.id, same(want[t.id])]);
      expect(me.tiles.length).toBeGreaterThan(3);
    }
  });
});

describe("the timing heatmap: each lead counted once, in its business hour", () => {
  it("arrivals by weekday and hour are the script's, and add up to the new leads", async () => {
    const tm = await get(admin, `analytics/timing?${custom(JUNE)}`);
    const want = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: FIXTURE_TZ,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    });
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (const s of script()) {
      const d = dayOf(s.arrival, FIXTURE_TZ);
      if (d < JUNE[0] || d > JUNE[1]) continue;
      const parts = Object.fromEntries(f.formatToParts(s.arrival).map((x) => [x.type, x.value]));
      want[DOW.indexOf(parts.weekday!)]![Number(parts.hour)]! += 1;
    }
    expect(tm.arrivals).toEqual(want);
    const total = (tm.arrivals as number[][]).flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(reference(...JUNE, null).new_leads);
  });
});

describe("goals: progress is the period's own number, and the pace is the share of the period gone", () => {
  it("a business won goal and a person's revenue goal for June", async () => {
    const set = (scope: string, scopeId: string | null, metric: string, target: number) =>
      h.queryAll(
        `INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'month', '2026-06-01', $4, $5)`,
        [scope, scopeId, metric, target, admin.id],
      );
    await set("business", null, "won", 50);
    await set("user", fx.people[1]!.id, "revenue", 9000);
    // June 15, midday in Kolkata: 15 of June's 30 days have begun.
    h.clock.now = new Date("2026-06-15T06:30:00Z");
    const g = await get(admin, "analytics/goals?start=2026-06-01&period=month");
    const month = reference("2026-06-01", "2026-06-30", null);
    const one = reference("2026-06-01", "2026-06-30", 1);
    const biz = g.goals.find((x: { scope: string }) => x.scope === "business");
    const own = g.goals.find((x: { scopeId: string }) => x.scopeId === fx.people[1]!.id);
    expect([biz.value, biz.target, biz.elapsed]).toEqual([month.won, 50, 15 / 30]);
    expect(biz.pace).toEqual(expect.closeTo(month.won! / (15 / 30) / 50, 9));
    expect([own.value, own.target]).toEqual([one.revenue_won, 9000]);
    await h.queryAll("DELETE FROM goals");
  });
});

describe("Today's tiles agree with Analytics", () => {
  it("the month tile is June so far against the same days of May; Team's overdue is the Overview's", async () => {
    // June 20, midday in Kolkata.
    h.clock.now = new Date("2026-06-20T06:30:00Z");
    const t = await get(admin, "today/tiles");
    const juneSoFar = reference("2026-06-01", "2026-06-20", null);
    const maySame = reference("2026-05-01", "2026-05-20", null);
    expect([t.month.value, t.month.previous]).toEqual([juneSoFar.revenue_won, maySame.revenue_won]);
    const o = await get(admin, "analytics/overview?range=this_month");
    expect(o.tiles.find((x: { id: string }) => x.id === "revenue_won").value).toBe(t.month.value);
    // Overdue right now: open follow-ups due before now (the script leaves every eighth one open).
    const open = script().filter((s) => s.task && !s.task.done && s.task.due < h.clock.now).length;
    expect(t.team.overdue).toBe(open);
    expect(o.tiles.find((x: { id: string }) => x.id === "overdue_now").value).toBe(open);
  });

  it("the Leads tile's new today is Analytics' new leads for today, and its hours add up to it", async () => {
    h.clock.now = new Date("2026-06-20T18:00:00Z"); // 23:30 in Kolkata: the whole day in
    const t = await get(admin, "today/tiles");
    const want = reference("2026-06-20", "2026-06-20", null).new_leads;
    expect(want).toBeGreaterThan(0);
    expect(t.leads.today).toBe(want);
    expect((t.leads.hours as number[]).reduce((a, b) => a + b, 0)).toBe(want);
    const o = await get(admin, "analytics/overview?range=today");
    expect(o.tiles.find((x: { id: string }) => x.id === "new_leads").value).toBe(want);
    // Same weekday last week, by this time: the script's own count.
    const lastWeek = script().filter(
      (s) =>
        dayOf(s.arrival, FIXTURE_TZ) === "2026-06-13" &&
        s.arrival.getTime() < h.clock.now.getTime() - 7 * 86_400_000,
    ).length;
    expect(t.leads.lastWeek).toBe(lastWeek);
  });
});
