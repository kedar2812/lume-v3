import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, analyticsSeed } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let A: SeededUser;
const TZ = "America/New_York";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
// 0 = Sunday … 6 = Saturday, in the business's time.
const MON = 1;
const TUE = 2;
const WED = 3;
const FRI = 5;

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = new Date("2026-06-20T16:00:00Z");
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  A = await h.seedUser({ name: "Asha", grants: [{ key: "analytics.view", scope: "own" }] });
  // 03:30 UTC on June 2 is 23:30 on Monday June 1 in New York: outside the window. 13:00 UTC is 09:00 on Tuesday.
  await s.lead({ owner: A.id, at: new Date("2026-06-02T03:30:00Z") });
  await s.lead({ owner: A.id, at: new Date("2026-06-02T13:00:00Z") });
  // The window's edges: 22:15 on Tuesday is outside it; 07:00 on Wednesday is inside.
  await s.lead({ owner: A.id, at: new Date("2026-06-03T02:15:00Z") });
  await s.lead({ owner: A.id, at: new Date("2026-06-03T11:00:00Z") });
  // Friday June 5, 15:00 in New York (19:00 UTC): six calls held and one missed, each with its own lead.
  const fri = new Date("2026-06-05T19:00:00Z");
  for (let i = 0; i < 7; i++) {
    const lead = await s.lead({ owner: A.id, at: new Date("2026-05-20T14:00:00Z") });
    await s.meeting({ lead, owner: A.id, startsAt: fri, status: i < 6 ? "completed" : "no_show" });
  }
  // One cancelled, one moved, one still to come (the clock is June 20).
  for (const [startsAt, status] of [
    ["2026-06-10T15:00:00Z", "cancelled"],
    ["2026-06-12T15:00:00Z", "rescheduled"],
    ["2026-06-28T15:00:00Z", "scheduled"],
  ] as const) {
    const lead = await s.lead({ owner: A.id, at: new Date("2026-05-20T14:00:00Z") });
    await s.meeting({ lead, owner: A.id, startsAt: new Date(startsAt), status });
  }
  await rollupDays(h.pool, JUNE, TZ);
});
afterAll(async () => h.close());

const get = async (path: string) =>
  (await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/${path}` })).json();
const opens = async (token: string) =>
  (
    await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}` })
  ).json().total as number;

describe("timing and meetings (8D-1 Task 8)", () => {
  it("a source narrows the heatmaps and time in stage too (read from the leads), and each cell opens its leads", async () => {
    const src = (
      await h.ownerPool.query(
        "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Fair') RETURNING id",
      )
    ).rows[0].id as string;
    // Only Tuesday's 09:00 arrival came from the fair.
    await h.queryAll("UPDATE leads SET source_id = $1 WHERE created_at = '2026-06-02T13:00:00Z'", [src]);
    try {
      const t = await get(`timing?${Q}&source=${src}`);
      expect(t.arrivals.flat().reduce((a: number, n: number) => a + n, 0)).toBe(1);
      expect(t.arrivals[TUE][9]).toBe(1);
      expect(await opens(t.cells.arrivals[TUE][9].drill)).toBe(1);
      // The calls' leads came from nowhere in particular.
      expect(t.booking.flat().reduce((a: number, c: { n: number }) => a + c.n, 0)).toBe(0);
      expect(t.note ?? null).toBeNull();
      const long = await get(`timing?range=custom&from=2026-01-01&to=2026-06-30&source=${src}`);
      expect(long.note).toBe(
        "The heatmaps and time in stage can be narrowed by source for up to 92 days. Pick a shorter range to see them.",
      );
      expect(long.arrivals.flat().reduce((a: number, n: number) => a + n, 0)).toBe(0);
      expect(long.stages).toEqual([]);
    } finally {
      await h.queryAll("UPDATE leads SET source_id = NULL WHERE source_id = $1", [src]);
    }
  });

  it("a rep sees their own calls and arrivals, and nobody else's", async () => {
    const other = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
    const mine = (
      await (await h.signIn(A)).inject({ method: "GET", url: `/api/v1/analytics/timing?${Q}` })
    ).json();
    expect(mine.meetings.kpis.held).toBe(6);
    const theirs = (
      await (await h.signIn(other)).inject({ method: "GET", url: `/api/v1/analytics/timing?${Q}` })
    ).json();
    expect(theirs.meetings.kpis.held).toBe(0);
    expect(theirs.meetings.people).toEqual([]);
    expect(theirs.arrivals.flat().reduce((a: number, n: number) => a + n, 0)).toBe(0);
  });

  it("arrivals land in the business's own weekday and hour; outside 7 am – 10 pm they're counted apart", async () => {
    const t = await get(`timing?${Q}`);
    expect(t.window).toEqual({ startHour: 7, endHour: 22 });
    expect(t.arrivals[TUE][9]).toBe(1);
    expect(t.arrivals[MON][23]).toBe(1);
    expect(t.arrivals[TUE][22]).toBe(1);
    expect(t.arrivals[WED][7]).toBe(1);
    expect(t.outside.arrivals).toBe(2);
    expect(await opens(t.cells.arrivals[TUE][9].drill)).toBe(1);
  });

  it("the best booking slot is the one held most often, once it has enough calls", async () => {
    const t = await get(`timing?${Q}`);
    expect(t.booking[FRI][15].rate).toBeCloseTo(6 / 7, 6);
    expect(t.best.booking).toMatchObject({ dow: FRI, hour: 15, n: 7 });
    expect(t.best.replies).toBeUndefined();
  });

  it("no-shows are kept by the call's start slot", async () => {
    const rows = await h.queryAll<{ n: number }>(
      "SELECT sum(n)::int AS n FROM analytics_daily_slot WHERE kind = 'no_show' AND dow = $1 AND hour = 15",
      [FRI],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("meetings: the numbers, what happened to every call, per person; each opens its leads", async () => {
    const m = (await get(`timing?${Q}`)).meetings;
    expect(m.kpis).toMatchObject({ booked: 9, held: 6, cancelled: 1 });
    expect(m.kpis.heldRate).toBeCloseTo(6 / 7, 6);
    expect(m.kpis.noShowRate).toBeCloseTo(1 / 7, 6);
    expect(m.flow).toEqual({ booked: 10, held: 6, noShow: 1, cancelled: 1, rescheduled: 1, upcoming: 1 });
    expect(m.people).toEqual([{ id: A.id, name: "Asha", held: 6, noShow: 1, cancelled: 1 }]);
    expect(await opens(m.drill.held)).toBe(6);
    expect(await opens(m.drill.no_show)).toBe(1);
    expect(await opens(m.drill.cancelled)).toBe(1);
  });
});
