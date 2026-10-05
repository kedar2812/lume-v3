import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { reference, seedFixture, FIXTURE_TZ, type Fixture } from "../../../test/fixtures/analytics";
import { rollupDays } from "./rollup";

let h: Harness;
let fx: Fixture;
let admin: SeededUser;
let small: Harness;

beforeAll(async () => {
  h = await createHarness();
  fx = await seedFixture(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "settings.manage", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  const days: string[] = [];
  for (let t = Date.UTC(2026, 4, 1); t <= Date.UTC(2026, 6, 15); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  await rollupDays(h.pool, days, FIXTURE_TZ);
  small = await createHarness();
}, 240_000);
afterAll(async () => {
  await h.close();
  await small.close();
});

describe("goals and spend (8B)", () => {
  it("an admin sets a goal; everyone in reach sees its progress, and the pace is an estimate over the time gone", async () => {
    const c = await h.signIn(admin);
    const put = await c.inject({
      method: "PUT",
      url: "/api/v1/analytics/goals",
      payload: {
        scope: "business",
        scopeId: null,
        metric: "won",
        period: "month",
        periodStart: "2026-06-01",
        target: 40,
      },
    });
    expect(put.statusCode).toBe(200);
    await c.inject({
      method: "PUT",
      url: "/api/v1/analytics/goals",
      payload: {
        scope: "user",
        scopeId: fx.people[0]!.id,
        metric: "new_leads",
        period: "month",
        periodStart: "2026-06-01",
        target: 50,
      },
    });
    const list = (await c.inject({ method: "GET", url: "/api/v1/analytics/goals?start=2026-06-01" })).json();
    const business = list.goals.find((g: { scope: string }) => g.scope === "business");
    const want = reference("2026-06-01", "2026-06-30", null).won!;
    expect(business).toMatchObject({
      metric: "won",
      target: 40,
      value: want,
      progress: want / 40,
      elapsed: 1,
      daysLeft: 0,
    });
    // The rep sees their own goal, not the business's.
    const rep = (
      await (
        await h.signIn(fx.people[0]!)
      ).inject({ method: "GET", url: "/api/v1/analytics/goals?start=2026-06-01" })
    ).json();
    expect(rep.goals.map((g: { scope: string }) => g.scope)).toEqual(["user"]);
    expect(rep.goals[0].value).toBe(reference("2026-06-01", "2026-06-30", 0).new_leads);
  });

  it("every person's goal and a team's count their own numbers, however many there are", async () => {
    const c = await h.signIn(admin);
    const set = (scope: string, scopeId: string | null, metric: string, target: number) =>
      c.inject({
        method: "PUT",
        url: "/api/v1/analytics/goals",
        payload: { scope, scopeId, metric, period: "month", periodStart: "2026-07-01", target },
      });
    const metrics = ["won", "revenue", "new_leads", "ontime"] as const;
    for (const p of fx.people) for (const m of metrics) await set("user", p.id, m, m === "ontime" ? 0.9 : 10);
    const team = await h.ownerPool.query(
      "INSERT INTO teams (id, name) VALUES (gen_random_uuid(), 'Two of them') RETURNING id",
    );
    const teamId = team.rows[0].id as string;
    for (const p of fx.people.slice(0, 2))
      await h.ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, p.id]);
    await set("team", teamId, "won", 10);
    const list = (await c.inject({ method: "GET", url: "/api/v1/analytics/goals?start=2026-07-01" })).json();
    const got = (scope: string, id: string, m: string) =>
      list.goals.find(
        (g: { scope: string; scopeId: string; metric: string }) =>
          g.scope === scope && g.scopeId === id && g.metric === m,
      )?.value;
    const key = { won: "won", revenue: "revenue_won", new_leads: "new_leads", ontime: "ontime" } as const;
    fx.people.forEach((p, i) => {
      const ref = reference("2026-07-01", "2026-07-31", i);
      for (const m of metrics) expect([i, m, got("user", p.id, m)]).toEqual([i, m, ref[key[m]] ?? 0]);
    });
    const two = [0, 1].reduce((a, i) => a + reference("2026-07-01", "2026-07-31", i).won!, 0);
    expect(got("team", teamId, "won")).toBe(two);
  });

  it("only admins set goals and spend; a quarter starts in its first month", async () => {
    const rep = await h.signIn(fx.people[1]!);
    const body = {
      scope: "business",
      scopeId: null,
      metric: "won",
      period: "month",
      periodStart: "2026-07-01",
      target: 5,
    };
    expect(
      (await rep.inject({ method: "PUT", url: "/api/v1/analytics/goals", payload: body })).statusCode,
    ).toBe(403);
    const c = await h.signIn(admin);
    const q = await c.inject({
      method: "PUT",
      url: "/api/v1/analytics/goals",
      payload: { ...body, period: "quarter", periodStart: "2026-08-01" },
    });
    expect(q.statusCode).toBe(400);
    const spend = await c.inject({
      method: "PUT",
      url: `/api/v1/settings/sources/${fx.sources[0]}/spend`,
      payload: { monthlySpend: 12000 },
    });
    expect(spend.json()).toEqual({ id: fx.sources[0], monthlySpend: 12000 });
    expect(
      (
        await rep.inject({
          method: "PUT",
          url: `/api/v1/settings/sources/${fx.sources[0]}/spend`,
          payload: { monthlySpend: 1 },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("Sources & spend reads each source with what it costs a month; only admins", async () => {
    const c = await h.signIn(admin);
    await c.inject({
      method: "PUT",
      url: `/api/v1/settings/sources/${fx.sources[1]}/spend`,
      payload: { monthlySpend: 4500.5 },
    });
    const r = await c.inject({ method: "GET", url: "/api/v1/settings/sources" });
    expect(r.statusCode).toBe(200);
    const one = r.json().sources.find((x: { id: string }) => x.id === fx.sources[1]);
    expect(one).toMatchObject({ id: fx.sources[1], monthlySpend: 4500.5 });
    expect(one).toEqual(expect.objectContaining({ name: expect.any(String), type: expect.any(String) }));
    const rep = await h.signIn(fx.people[1]!);
    expect((await rep.inject({ method: "GET", url: "/api/v1/settings/sources" })).statusCode).toBe(403);
  });
});

describe("LUME noticed (8B)", () => {
  it("waits for enough to go on, and says how far along it is", async () => {
    const u = await small.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
    const r = (
      await (await small.signIn(u)).inject({ method: "GET", url: "/api/v1/analytics/insights?range=30d" })
    ).json();
    expect(r).toMatchObject({
      ready: false,
      title: "LUME needs a little more to go on",
      progress: "0 of 200 leads",
      insights: [],
    });
  });

  it("speaks once there's enough, in its own words, and doesn't repeat itself for 14 days", async () => {
    const c = await h.signIn(admin);
    const url = "/api/v1/analytics/insights?range=custom&from=2026-06-01&to=2026-06-28";
    const first = (await c.inject({ method: "GET", url })).json();
    expect(first.ready).toBe(true);
    expect(first.insights.length).toBeLessThanOrEqual(3);
    for (const i of first.insights) {
      expect(i.title.length).toBeGreaterThan(5);
      expect(i.body).toMatch(/\.$/);
    }
    const again = (await c.inject({ method: "GET", url })).json();
    const firstKeys = first.insights.map((i: { id: string; subject: string }) => `${i.id}:${i.subject}`);
    for (const i of again.insights) expect(firstKeys).not.toContain(`${i.id}:${i.subject}`);
  });
});
