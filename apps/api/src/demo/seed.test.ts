import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../test/harness";
import { DemoSeedRefused, seedDemoBusiness } from "./seed";

/**
 * The demo business (8D spec §3): a made-up "Brightpath Studio" with six months of natural data, ending today. It
 * must be the same every time for the same seed and day, refuse a LUME that already has leads, use only fictional
 * contacts, and carry the patterns LUME noticed is meant to find.
 */
let a: Harness;
let b: Harness;
let viewer: SeededUser;
const NOW = new Date();

beforeAll(async () => {
  [a, b] = await Promise.all([createHarness(), createHarness()]);
  // Read on the day the business ends, as a live LUME would.
  a.clock.now = NOW;
  b.clock.now = NOW;
  await Promise.all([
    seedDemoBusiness(a.ownerPool, { now: NOW, seed: 7 }),
    seedDemoBusiness(b.ownerPool, { now: NOW, seed: 7 }),
  ]);
  viewer = await a.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
}, 300_000);
afterAll(async () => Promise.all([a.close(), b.close()]));

const fingerprint = async (h: Harness) => {
  const [totals] = await h.queryAll<{ n: number; v: string; won: number; lost: number }>(
    "SELECT count(*)::int AS n, coalesce(sum(value), 0)::text AS v, count(won_at)::int AS won, count(lost_at)::int AS lost FROM leads",
  );
  const names = await h.queryAll<{ name: string }>(
    "SELECT name FROM leads ORDER BY created_at, name LIMIT 10",
  );
  return { totals, names: names.map((r) => r.name) };
};

describe("the demo business (8D-1 Task 14)", () => {
  it("is the same for the same seed and day", async () => {
    expect(await fingerprint(a)).toEqual(await fingerprint(b));
  });

  it("is a believable business: about 3,000 leads, wins, losses, meetings and follow-ups", async () => {
    const { totals } = await fingerprint(a);
    expect(totals!.n).toBeGreaterThan(2500);
    expect(totals!.n).toBeLessThan(3600);
    expect(totals!.won / totals!.n).toBeGreaterThan(0.03);
    expect(totals!.won / totals!.n).toBeLessThan(0.09);
    expect(totals!.lost / totals!.n).toBeGreaterThan(0.2);
    const [m] = await a.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM meetings");
    expect(m!.n).toBeGreaterThan(300);
    const [t] = await a.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM tasks");
    expect(t!.n).toBeGreaterThan(1000);
  });

  it("stores its answers as LUME does: each budget answer is one of the field's option ids", async () => {
    const [field] = await a.queryAll<{ options: { id: string; label: string }[] }>(
      "SELECT options FROM field_definitions WHERE key = 'budget'",
    );
    expect(field!.options.length).toBeGreaterThan(1);
    for (const o of field!.options) expect(o).toEqual({ id: expect.any(String), label: expect.any(String) });
    const answers = await a.queryAll<{ v: string; n: number }>(
      "SELECT custom->>'budget' AS v, count(*)::int AS n FROM leads WHERE custom ? 'budget' GROUP BY 1",
    );
    expect(answers.length).toBeGreaterThan(1);
    expect(answers.map((x) => x.v).sort()).toEqual(field!.options.map((o) => o.id).sort());
  });

  it("reads like real life in the list and the calendar: last activity spread over time, meetings named", async () => {
    const [recent] = await a.queryAll<{ n: number; all: number }>(
      "SELECT count(*) FILTER (WHERE last_activity_at > now() - interval '10 minutes' OR updated_at > now() - interval '10 minutes')::int AS n, count(*)::int AS all FROM leads",
    );
    expect(recent!.n / recent!.all).toBeLessThan(0.05);
    const titles = await a.queryAll<{ title: string }>("SELECT DISTINCT title FROM meetings");
    expect(titles.length).toBeGreaterThan(2);
    expect(titles.map((t) => t.title)).not.toContain("Call");
  });

  it("uses only made-up contacts", async () => {
    const bad = await a.queryAll<{ email: string }>(
      "SELECT email FROM leads WHERE email IS NOT NULL AND email NOT LIKE '%@example.com' LIMIT 3",
    );
    expect(bad).toEqual([]);
    const people = await a.queryAll<{ email: string }>(
      "SELECT email::text FROM users WHERE password_hash IS NULL AND email NOT LIKE '%@example.com'",
    );
    expect(people).toEqual([]);
    // Phones from the range set aside for drama (+44 7700 900xxx), never a real person's.
    const phones = await a.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM leads WHERE phone_e164 IS NOT NULL AND phone_e164 NOT LIKE '+447700900%'",
    );
    expect(phones[0]!.n).toBe(0);
  });

  it("the last 30 days read like a real month", async () => {
    const o = (
      await (await a.signIn(viewer)).inject({ method: "GET", url: "/api/v1/analytics/overview?range=30d" })
    ).json();
    const n = o.tiles.find((t: { id: string }) => t.id === "new_leads").value;
    expect(n).toBeGreaterThan(400);
    expect(n).toBeLessThan(800);
    // Open stages carry a chance of winning, so the forecast means something.
    expect(o.tiles.find((t: { id: string }) => t.id === "forecast").value).toBeGreaterThan(0);
  });

  it("LUME noticed finds the patterns planted in it", async () => {
    // At most three show at once, and what someone has seen rests for 14 days: visiting again shows the next ones.
    const ids: string[] = [];
    for (let visit = 0; visit < 4; visit++) {
      const r = (
        await (await a.signIn(viewer)).inject({ method: "GET", url: "/api/v1/analytics/insights?range=90d" })
      ).json();
      expect(r.ready).toBe(true);
      if (visit === 0) expect(r.insights.length).toBe(3);
      ids.push(...r.insights.map((i: { id: string }) => i.id));
    }
    // Every pattern planted in it: speed, both sources, evening arrivals, Leo's Mondays, missed Monday calls, won back.
    for (const id of [
      "speed_pays",
      "source_over",
      "source_under",
      "evening_arrivals",
      "weekday_late",
      "slot_noshow",
      "won_back",
    ])
      expect(ids, id).toContain(id);
  });

  it("refuses a LUME that already has leads, and writes nothing", async () => {
    const [before] = await a.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM users");
    await expect(seedDemoBusiness(a.ownerPool, { now: NOW })).rejects.toBeInstanceOf(DemoSeedRefused);
    const [after] = await a.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM users");
    expect(after!.n).toBe(before!.n);
  });
});

describe("a growing business (the website's captures, spec §4.1)", () => {
  let g: Harness;
  let who: SeededUser;
  beforeAll(async () => {
    g = await createHarness();
    g.clock.now = NOW;
    await seedDemoBusiness(g.ownerPool, { now: NOW, seed: 7, trajectory: "growing" });
    who = await g.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "analytics.revenue", scope: null },
        { key: "leads.view", scope: "all" },
      ],
    });
  }, 300_000);
  afterAll(async () => g.close());

  it("the last 30 days beat the 30 before on what an owner looks at first", async () => {
    const o = (
      await (
        await g.signIn(who)
      ).inject({ method: "GET", url: "/api/v1/analytics/overview?range=30d&compare=1" })
    ).json();
    const tone = (id: string) => o.tiles.find((t: { id: string }) => t.id === id)?.trend?.tone;
    for (const id of ["new_leads", "revenue_won", "won", "reply_rate", "speed_to_lead"])
      expect([id, tone(id)]).toEqual([id, "good"]);
    const good = o.tiles.filter((t: { trend?: { tone?: string } }) => t.trend?.tone === "good").length;
    expect(good).toBeGreaterThanOrEqual(8);
  });

  it("has only a handful of numbers LUME couldn't read (the site shows its Overview)", async () => {
    const [row] = await g.queryAll(
      "SELECT (count(*) FILTER (WHERE phone_status = 'needs_country'))::float / count(*) AS share FROM leads",
    );
    expect(row.share).toBeLessThan(0.01);
  });

  it("still carries the patterns LUME notices", async () => {
    const c = await g.signIn(who);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        ...(await c.inject({ method: "GET", url: "/api/v1/analytics/insights?range=90d" }))
          .json()
          .insights.map((x: { id: string }) => x.id),
      );
    for (const id of ["speed_pays", "source_under", "evening_arrivals"]) expect(ids, id).toContain(id);
  });
});
