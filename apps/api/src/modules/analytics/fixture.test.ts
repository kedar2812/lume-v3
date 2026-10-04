import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import {
  reference,
  reference8d,
  seedFixture,
  FIXTURE_TZ,
  type Fixture,
} from "../../../test/fixtures/analytics";
import { rollupDays } from "./rollup";

let h: Harness;
let fx: Fixture;
let admin: SeededUser;
const RANGES: [string, string][] = [
  ["2026-05-04", "2026-05-31"],
  ["2026-06-01", "2026-06-28"],
];
const COMPARED = [
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

const tiles = async (who: SeededUser, [from, to]: [string, string], extra = "") => {
  const r = await (
    await h.signIn(who)
  ).inject({
    method: "GET",
    url: `/api/v1/analytics/overview?range=custom&from=${from}&to=${to}${extra}`,
  });
  expect(r.statusCode).toBe(200);
  const body = r.json() as { tiles: { id: string; value: number | null }[]; drill: Record<string, string> };
  return { body, value: (id: string) => body.tiles.find((t) => t.id === id)?.value ?? null };
};

describe("a fully known business: the engine matches the script, to the unit (8A Task 7)", () => {
  for (const range of RANGES) {
    it(`everyone's numbers, ${range[0]} to ${range[1]}`, async () => {
      const want = reference(range[0], range[1], null);
      const { value } = await tiles(admin, range);
      for (const id of COMPARED) expect([id, value(id)]).toEqual([id, closeTo(want[id]!)]);
      // Sanity: the script really exercises each number.
      expect(want.new_leads).toBeGreaterThan(150);
      expect(want.won).toBeGreaterThan(10);
    });

    it(`each person's own numbers equal the admin's filtered to them, ${range[0]} to ${range[1]}`, async () => {
      for (const [p, person] of fx.people.entries()) {
        const want = reference(range[0], range[1], p);
        const own = await tiles(person, range);
        const filtered = await tiles(admin, range, `&owner=${person.id}`);
        for (const id of ["new_leads", "contacted", "reply_rate", "won", "win_rate", "lost", "ontime"]) {
          expect([p, id, own.value(id)]).toEqual([p, id, closeTo(want[id]!)]);
          expect(filtered.value(id)).toEqual(own.value(id));
        }
      }
    });
  }

  it("every tile's drill-down opens exactly as many leads as it counts", async () => {
    const { body, value } = await tiles(admin, RANGES[1]!);
    const c = await h.signIn(admin);
    const count = async (id: string) =>
      (await c.inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${body.drill[id]}` })).json()
        .total as number;
    expect(await count("new_leads")).toBe(value("new_leads"));
    expect(await count("won")).toBe(value("won"));
    expect(await count("lost")).toBe(value("lost"));
    expect(await count("contacted")).toBe(Math.round(value("contacted")! * value("new_leads")!));
  });
});

describe("the 8D numbers match the script's own answers (8D-1 Task 13)", () => {
  const get = async (path: string) => {
    const r = await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/${path}` });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json();
  };
  for (const range of RANGES)
    for (const person of [null, 0, 3] as const)
      it(`revenue by package, meetings, won back, lost by reason and source, the funnel's split — ${range.join(" to ")}, ${person === null ? "everyone" : `person ${person}`}`, async () => {
        const want = reference8d(range[0], range[1], person);
        const q = `range=custom&from=${range[0]}&to=${range[1]}${person === null ? "" : `&owner=${fx.people[person]!.id}`}`;
        // Sanity: the script really exercises each of them.
        if (person === null) {
          expect(want.byProduct.size).toBeGreaterThanOrEqual(3);
          expect(want.kpis.held).toBeGreaterThan(3);
          expect(want.wonBackFlow.won).toBeGreaterThan(1);
        }
        const rev = await get(`revenue?${q}`);
        const got = new Map<string | null, { deals: number; value: number }>(
          rev.byProduct.map((p: { id: string | null; deals: number; value: number }) => [
            p.id,
            { deals: p.deals, value: p.value },
          ]),
        );
        const expected = new Map(
          [...want.byProduct].map(([i, v]) => [i === null ? null : fx.products[i]!, v] as const),
        );
        expect(got).toEqual(expected);

        const m = (await get(`timing?${q}`)).meetings.kpis;
        expect({ booked: m.booked, held: m.held, cancelled: m.cancelled }).toEqual({
          booked: want.kpis.booked,
          held: want.kpis.held,
          cancelled: want.kpis.cancelled,
        });
        const shown = want.kpis.held + want.kpis.noShow;
        expect(m.noShowRate).toEqual(shown ? closeTo(want.kpis.noShow / shown) : null);

        const l = await get(`lost?${q}`);
        expect(l.wonBackFlow).toMatchObject(want.wonBackFlow);
        const cells = new Map<string, number>(
          l.matrix.cells.map((c: { reasonId: string; sourceId: string; n: number }) => [
            `${fx.reasons.indexOf(c.reasonId)}:${fx.sources.indexOf(c.sourceId)}`,
            c.n,
          ]),
        );
        expect(cells).toEqual(want.matrix);

        const f = await get(`funnel?${q}&split=source`);
        const arrived = new Map<number, number>(
          f.split.groups.map((g: { id: string; arrived: number }) => [fx.sources.indexOf(g.id), g.arrived]),
        );
        expect(arrived).toEqual(want.arrivedBySource);
      });
});

/** Rates compared to 1e-9; counts and money exactly. */
function closeTo(v: number | null) {
  if (v === null) return null;
  return Number.isInteger(v) ? v : expect.closeTo(v, 9);
}
