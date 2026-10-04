import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let R: SeededUser;
let O: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const LATE_JUNE = "range=custom&from=2026-06-16&to=2026-06-30";
const own = [
  { key: "analytics.view", scope: "own" },
  { key: "leads.view", scope: "own" },
] as const;

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  R = await h.seedUser({ name: "Riya", grants: [...own] });
  O = await h.seedUser({ name: "Omar", grants: [...own] });
  // Riya: 20 leads on June 16–25, 5 won. Omar: 30 on June 1–15 and 10 on June 16–25, 7 won.
  for (let i = 0; i < 20; i++) {
    const t = at(6, 16 + Math.floor(i / 2), 6 + (i % 2));
    await s.lead({
      owner: R.id,
      at: t,
      ...(i < 5 ? { wonAt: new Date(t.getTime() + 86_400_000), value: 100 } : {}),
    });
  }
  for (let i = 0; i < 40; i++) {
    const t = i < 30 ? at(6, 1 + Math.floor(i / 2), 6 + (i % 2)) : at(6, 16 + (i - 30), 6);
    await s.lead({
      owner: O.id,
      at: t,
      ...(i < 7 ? { wonAt: new Date(t.getTime() + 86_400_000), value: 100 } : {}),
    });
  }
  // Riya's open follow-ups: seven, due over the coming week; Omar has one too.
  const lead = await s.lead({ owner: R.id, at: at(5, 1) });
  for (let k = 7; k >= 1; k--)
    await h.queryAll(
      `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + make_interval(days => $4), 'open', gen_random_uuid())`,
      [lead, R.id, `Call ${k}`, k],
    );
  await s.task(lead, O.id, new Date(Date.now() + 3_600_000), null);
  // Two messages Riya sent on Tuesday June 16 (10:00 and 11:00 in Kolkata) to two leads; one answered next day.
  const sent = async (to: string, when: Date, replied: boolean) => {
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, user_id, type, occurred_at) VALUES (gen_random_uuid(), $1, $2, 'whatsapp_confirmed_sent', $3)",
      [to, R.id, when],
    );
    if (replied)
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reply_logged', $2)",
        [to, new Date(when.getTime() + 86_400_000)],
      );
  };
  await sent(lead, at(6, 16, 4, 30), true);
  await sent(await s.lead({ owner: R.id, at: at(5, 2) }), at(6, 16, 5, 30), false);
  await h.ownerPool.query(
    "INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target) VALUES (gen_random_uuid(), 'user', $1, 'won', 'month', '2026-06-01', 10)",
    [R.id],
  );
  await rollupDays(h.pool, JUNE, TZ);
});
afterAll(async () => h.close());

const me = async (u: SeededUser, q = Q) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/me?${q}` })).json();

describe("a rep's own numbers (8D-1 Task 10)", () => {
  it("their tiles are the overview's, filtered to them", async () => {
    const mine = await me(R);
    const admins = (
      await (
        await h.signIn(admin)
      ).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=${R.id}` })
    ).json();
    expect(mine.tiles.length).toBeGreaterThan(0);
    for (const t of mine.tiles) {
      const a = admins.tiles.find((x: { id: string }) => x.id === t.id);
      expect(t.value, t.id).toEqual(a.value);
    }
    expect(mine.tiles.find((t: { id: string }) => t.id === "won").value).toBe(5);
  });

  it("their win rate beside the business's, once the business has enough leads", async () => {
    const mine = await me(R);
    expect(mine.funnel.myWinRate).toBeCloseTo(5 / 20, 6);
    expect(mine.funnel.businessWinRate).toBeCloseTo(12 / 60, 6);
    // Late June: only 30 leads in the whole business, too few to compare with.
    expect((await me(R, LATE_JUNE)).funnel.businessWinRate).toBeNull();
  });

  it("asking for someone else's numbers still gives their own", async () => {
    const mine = await me(R, `${Q}&owner=${O.id}`);
    expect(mine.tiles.find((t: { id: string }) => t.id === "new_leads").value).toBe(20);
  });

  it("their next five follow-ups, soonest first; their goal with its pace", async () => {
    const mine = await me(R);
    expect(mine.followUps.next.map((t: { title: string }) => t.title)).toEqual([
      "Call 1",
      "Call 2",
      "Call 3",
      "Call 4",
      "Call 5",
    ]);
    expect(mine.goals).toEqual([expect.objectContaining({ metric: "won", target: 10, value: 5 })]);
  });

  it("their goal and the month's line count the whole month, whatever range is on screen", async () => {
    // Riya won on June 17, 17, 18, 18 and 19; the screen shows June 19 onwards.
    const mine = await me(R, "range=custom&from=2026-06-19&to=2026-06-30");
    expect(mine.tiles.find((t: { id: string }) => t.id === "won").value).toBe(1);
    expect(mine.goals).toEqual([expect.objectContaining({ metric: "won", target: 10, value: 5 })]);
    // June is over: the pace is where it ended.
    expect(mine.goals[0].pace).toBeCloseTo(0.5, 6);
    expect(mine.heroLine).toBe("Your June: 5 won");
  });

  it("when their leads reply, by weekday, Monday first", async () => {
    const mine = await me(R);
    expect(mine.replyDays.map((d: { dow: number }) => d.dow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    const tue = mine.replyDays.find((d: { dow: number }) => d.dow === 2);
    // Both messages count as sent; one was answered within 72 hours. Two is too few to go on.
    expect(tue).toMatchObject({ sends: 2, rate: 0.5, tooFew: true });
    expect(mine.replyDays.find((d: { dow: number }) => d.dow === 3)).toMatchObject({ sends: 0, rate: null });
    expect(mine.heroLine).toContain("5 won");
  });
});
