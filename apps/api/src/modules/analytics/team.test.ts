import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, MAY, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let A: SeededUser;
let B: SeededUser;
let C: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
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
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  A = await h.seedUser({ name: "Asha", grants: [...own] });
  B = await h.seedUser({ name: "Bilal", grants: [...own] });
  C = await h.seedUser({ name: "Chen", grants: [...own] });
  // June arrivals: Asha 4 (contacted at 30, 30, 90, 90 minutes; the first two replied), Bilal 2 (one contacted at
  // 20 minutes and replied), Chen 1 (not contacted).
  for (const [i, mins] of [30, 30, 90, 90].entries()) {
    const t = at(6, i + 1);
    await s.contact(await s.lead({ owner: A.id, at: t }), t, mins, i < 2);
  }
  const b1 = at(6, 5);
  await s.contact(await s.lead({ owner: B.id, at: b1 }), b1, 20, true);
  await s.lead({ owner: B.id, at: at(6, 6) });
  await s.lead({ owner: C.id, at: at(6, 7) });
  // Wins: June — Asha 3 × 1,000, Bilal 2 × 3,000, Chen 1 × 500; May — Asha 1, Bilal 3, Chen 2.
  // Each win from a lead that arrived the month before, so it isn't one of the month's arrivals.
  const win = async (owner: string, month: number, day: number, value: number) =>
    s.lead({ owner, at: at(month - 1, 20), wonAt: at(month, day), value });
  for (const d of [10, 11, 12]) await win(A.id, 6, d, 1000);
  const bWins: string[] = [];
  for (const d of [13, 14]) bWins.push(await win(B.id, 6, d, 3000));
  // One of Bilal's won leads is handed to Chen after the win: the win stays Bilal's.
  await h.queryAll(
    "INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_at) VALUES ($1, $2, $3, $4)",
    [bWins[0], B.id, C.id, at(6, 20)],
  );
  await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [bWins[0], C.id]);
  await win(C.id, 6, 15, 500);
  await win(A.id, 5, 20, 100);
  for (const d of [20, 21, 22]) await win(B.id, 5, d, 100);
  for (const d of [23, 24]) await win(C.id, 5, d, 100);
  // Calls held in June: Asha 2, Bilal 1.
  const ml = await s.lead({ owner: A.id, at: at(5, 2) });
  await s.meeting({ lead: ml, owner: A.id, startsAt: at(6, 8, 9), status: "completed" });
  await s.meeting({ lead: ml, owner: A.id, startsAt: at(6, 9, 9), status: "completed" });
  await s.meeting({ lead: ml, owner: B.id, startsAt: at(6, 9, 10), status: "completed" });
  // Follow-ups due in June: Asha one on time and one late; Bilal one on time.
  await s.task(ml, A.id, at(6, 10, 6), at(6, 10, 6, 2));
  await s.task(ml, A.id, at(6, 11, 6), at(6, 12, 6));
  await s.task(ml, B.id, at(6, 11, 6), at(6, 11, 5));
  await h.ownerPool.query(
    "INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target) VALUES (gen_random_uuid(), 'user', $1, 'won', 'month', '2026-06-01', 5)",
    [A.id],
  );
  await rollupDays(h.pool, [...MAY, ...JUNE], TZ);
});
afterAll(async () => h.close());

const get = async (u: SeededUser, q = Q) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/team?${q}` })).json();
type Row = {
  id: string;
  won: number;
  within1h: number | null;
  replyRate: number | null;
  held: number;
  previousRank: Record<string, number | null>;
  goal: { metric: string; target: number; value: number } | null;
  drill: { cohort: string; won: string };
  assigned: number;
};

describe("the team (8D-1 Task 7)", () => {
  it("ranks by wins, with each person's place the period before", async () => {
    const t = await get(admin);
    const rows: Row[] = t.people;
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual([A.id, B.id, C.id]);
    // Credited to whoever owned each lead when it was won, not who owns it now.
    expect(rows.map((r) => r.won)).toEqual([3, 2, 1]);
    const rank = (id: string) => rows.find((r) => r.id === id)!.previousRank;
    expect(rank(B.id).won).toBe(1);
    expect(rank(C.id).won).toBe(2);
    expect(rank(A.id).won).toBe(3);
    // Revenue ranks the money, not the count: Bilal, Asha, Chen.
    expect(rank(B.id).revenue).toBe(1);
  });

  it("each person: assigned, within an hour, reply rate, calls held, the goal, and the leads behind them", async () => {
    const rows: Row[] = (await get(admin)).people;
    const a = rows.find((r) => r.id === A.id)!;
    expect(a).toMatchObject({ assigned: 4, within1h: 0.5, replyRate: 0.5, held: 2 });
    expect(a.goal).toEqual({ metric: "won", target: 5, value: 3 });
    const b = rows.find((r) => r.id === B.id)!;
    expect(b).toMatchObject({ within1h: 1, replyRate: 1, held: 1, goal: null });
    const c = rows.find((r) => r.id === C.id)!;
    expect(c.within1h).toBeNull();
    const ad = await h.signIn(admin);
    const opens = async (token: string) =>
      (
        await ad.inject({
          method: "GET",
          url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}`,
        })
      ).json().total;
    expect(await opens(a.drill.cohort)).toBe(4);
    expect(await opens(a.drill.won)).toBe(3);
  });

  it("follow-up discipline adds up to the overview's on-time tile", async () => {
    const t = await get(admin);
    const o = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })
    ).json();
    const tile = o.tiles.find((x: { id: string }) => x.id === "ontime").value;
    expect(t.discipline.ontime).toBeCloseTo(tile, 6);
    expect(t.discipline.ontime).toBeCloseTo(2 / 3, 6);
    const ap = t.discipline.people.find((p: { id: string }) => p.id === A.id);
    expect(ap.ontime).toBeCloseTo(0.5, 6);
  });

  it("a rep sees only their own row and no leaderboard", async () => {
    const t = await get(A);
    expect(t.leaderboard).toBe(false);
    expect(t.people.map((r: Row) => r.id)).toEqual([A.id]);
  });

  it("under a tag every lead carries, the live team agrees with the rollups", async () => {
    const tag = (
      await h.ownerPool.query("INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'all') RETURNING id")
    ).rows[0].id as string;
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) SELECT id, $1 FROM leads", [tag]);
    const plain = await get(admin);
    const live = await get(admin, `${Q}&tag=${tag}`);
    const pick = (t: { people: Row[] }) =>
      t.people.map((r) => [r.id, r.won, r.assigned, r.within1h, r.replyRate, r.held, r.previousRank.won]);
    expect(pick(live)).toEqual(pick(plain));
    expect(live.discipline.ontime).toBeCloseTo(plain.discipline.ontime, 6);
  });
});
