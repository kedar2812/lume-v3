import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

/**
 * The three detectors 8B wrote but the API never fed (8D-1 Task 11): a goal's pace, calls missed more often at one
 * time, and leads arriving after hours. One business with all three patterns planted, read halfway through June.
 */
let h: Harness;
let admin: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
// Kolkata is UTC+5:30: local 11:00 is 05:30 UTC, local 19:00 is 13:30 UTC.
const local = (day: number, hour: number) => at(6, day, hour - 6, 30);

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = new Date("2026-06-16T06:30:00Z"); // June 16, 12:00 in Kolkata: half of June gone
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  // 220 leads on weekdays of June 1–12 (working hours Mon–Fri 09:00–18:00): 130 at 11:00 and 90 at 19:00.
  const weekdays = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12];
  const leads: string[] = [];
  for (let i = 0; i < 220; i++)
    leads.push(await s.lead({ owner: admin.id, at: local(weekdays[i % 10]!, i < 130 ? 11 : 19) }));
  // Revenue so far: 3,000, against a June goal of 10,000. With 16 of June's 30 days gone (today counts, as goals
  // count it), that's 56% at this pace.
  for (const [i, v] of [1000, 2000].entries())
    await h.queryAll("UPDATE leads SET won_at = $2, value = $3 WHERE id = $1", [
      leads[i],
      local(10 + i, 12),
      v,
    ]);
  await h.ownerPool.query(
    "INSERT INTO goals (id, scope, metric, period, period_start, target) VALUES (gen_random_uuid(), 'business', 'revenue', 'month', '2026-06-01', 10000)",
  );
  // Calls on Monday mornings (08:30) are missed 10 times in 25; at other times (Wednesday 14:30) 5 in 100.
  for (let i = 0; i < 25; i++)
    await s.meeting({
      lead: leads[i]!,
      owner: admin.id,
      startsAt: local(i % 2 ? 8 : 1, 8),
      status: i < 10 ? "no_show" : "completed",
    });
  for (let i = 0; i < 100; i++)
    await s.meeting({
      lead: leads[25 + i]!,
      owner: admin.id,
      startsAt: local(i % 2 ? 10 : 3, 14),
      status: i < 5 ? "no_show" : "completed",
    });
  await rollupDays(h.pool, JUNE, TZ);
});
afterAll(async () => h.close());

const insights = async () => {
  // A fresh person each time: nothing they've seen is cooling down.
  const viewer = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
    ],
  });
  return (
    await (await h.signIn(viewer)).inject({ method: "GET", url: `/api/v1/analytics/insights?${Q}` })
  ).json();
};

describe("the detectors 8B wrote, now fed (8D-1 Task 11)", () => {
  it("goal pace, missed calls by time and after-hours arrivals all speak, in their own words", async () => {
    const r = await insights();
    expect(r.ready).toBe(true);
    const by = (id: string) => r.insights.find((i: { id: string }) => i.id === id);
    expect(by("goal_pace")).toMatchObject({ title: "At this pace, June ends at 56% of the revenue goal" });
    expect(by("goal_pace").body).toMatch(/so far, with 14 days to go\.$/);
    expect(by("slot_noshow")?.title).toBe("Calls on Monday 8–10 am are missed more often");
    expect(by("slot_noshow")?.body).toBe("40% of them were no-shows, against 5% at other times.");
    // No speed evidence in this business, so no advice about next mornings.
    expect(by("evening_arrivals")).toMatchObject({
      title: "41% of leads arrive after hours",
      body: "They come in after 6 pm.",
    });
  });
});
