import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsSeed } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "../analytics/rollup";

/**
 * Today's tiles (spec 2026-10-05-today-control-centre-design.md): every number is pinned to the definition the spec
 * writes for it — the owner's rule that nothing on Today is there without a reason, or untrue.
 */
let h: Harness;
let owner: SeededUser;
let rep: SeededUser;
let plain: SeededUser;
const TZ = "Asia/Kolkata";
// Monday, June 15 2026, 12:00 in Kolkata.
const NOW = new Date("2026-06-15T06:30:00Z");
/** A moment in Kolkata on a June day. */
const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 5, day, hh, mm) - 330 * 60_000);
const days = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `2026-06-${String(from + i).padStart(2, "0")}`);

type Tiles = {
  leads?: {
    today: number;
    lastWeek: number;
    hours: number[];
    usual: number[] | null;
    weeks: number;
    reached: number;
    medianMinutes: number | null;
  };
  month?: {
    money: boolean;
    value: number;
    previous: number;
    won: number;
    goal: { scope: string; target: number; value: number; elapsed: number } | null;
  };
  pipeline?: {
    name: string;
    many: boolean;
    open: number;
    stages: { name: string; n: number }[];
    wonThisMonth: number;
    forecast: number | null;
  };
  calendar: { week: number[]; today: number; held: number; todayIndex: number; connected: boolean };
  team?: { overdue: number; people: { name: string; n: number }[]; onTime: number | null };
  streak?: { days: number; best: number; dueToday: number; doneToday: number; last7: string[] };
  replies?: { rate: number | null; previous: number | null; series: (number | null)[]; best: unknown };
};
const tiles = async (u: SeededUser): Promise<Tiles> =>
  (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/today/tiles" })).json();

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = NOW;
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  owner = await h.seedUser({
    name: "Maya Kapoor",
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    name: "Riya Shah",
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  plain = await h.seedUser({ name: "Sam Plain", grants: [{ key: "leads.view", scope: "own" }] });

  // Today: three leads entered LUME this morning (one the rep's), one dated today but typed in last night, one dated
  // yesterday but typed in today (it isn't today's), one deleted.
  const a = await s.lead({ owner: owner.id, at: ist(15, 9, 10) });
  const b = await s.lead({ owner: owner.id, at: ist(15, 10, 5) });
  const c = await s.lead({ owner: rep.id, at: ist(15, 10, 40) });
  const dated = await s.lead({ owner: owner.id, at: ist(14, 23, 0) });
  await h.queryAll("UPDATE leads SET lead_created_at = '2026-06-15' WHERE id = $1", [dated]);
  const old = await s.lead({ owner: owner.id, at: ist(15, 11, 0) });
  await h.queryAll("UPDATE leads SET lead_created_at = '2026-06-14' WHERE id = $1", [old]);
  const gone = await s.lead({ owner: owner.id, at: ist(15, 11, 30) });
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [gone]);
  // First contacts 10, 20 and 30 minutes after arriving: a median of 20.
  await s.contact(a, ist(15, 9, 10), 10);
  await s.contact(b, ist(15, 10, 5), 20);
  await s.contact(c, ist(15, 10, 40), 30, true);
  // Last Monday: one in by noon, one after (not "by this time"). The Monday before: one at 10.
  await s.lead({ owner: owner.id, at: ist(8, 10, 0) });
  await s.lead({ owner: owner.id, at: ist(8, 15, 0) });
  await s.lead({ owner: owner.id, at: ist(1, 10, 30) });

  // Calls: the owner's today (held, scheduled, cancelled), Wednesday, and someone else's.
  await s.meeting({ lead: a, owner: owner.id, startsAt: ist(15, 10, 0), status: "completed" });
  await s.meeting({ lead: b, owner: owner.id, startsAt: ist(15, 16, 0), status: "scheduled" });
  await s.meeting({ lead: b, owner: owner.id, startsAt: ist(15, 17, 0), status: "cancelled" });
  await s.meeting({ lead: a, owner: owner.id, startsAt: ist(17, 11, 0), status: "scheduled" });
  await s.meeting({ lead: c, owner: rep.id, startsAt: ist(15, 14, 0), status: "scheduled" });

  // The rep's follow-ups: Sunday both done that day; Saturday's done a day late; Thursday's done on time;
  // today's still open. Nothing due Friday (skipped, not a break).
  await s.task(c, rep.id, ist(14, 10), ist(14, 12));
  await s.task(c, rep.id, ist(14, 15), ist(14, 18));
  await s.task(c, rep.id, ist(13, 10), ist(14, 9));
  await s.task(c, rep.id, ist(11, 10), ist(11, 11));
  await s.task(c, rep.id, ist(15, 17), null);
  // Overdue right now: two of the owner's, one of the rep's.
  await s.task(a, owner.id, ist(15, 9), null);
  await s.task(b, owner.id, ist(14, 9), null);
  await s.task(c, rep.id, ist(15, 11), null);

  // Won this month: one for the owner; and a deal in May, inside "the same days of last month".
  await s.lead({ owner: owner.id, at: ist(2, 10), wonAt: ist(10, 12), value: 50_000 });
  // (It arrived on May 3, a day the rollups below don't cover, so LUME's first arrival stays June 1.)
  await s.lead({
    owner: owner.id,
    at: new Date(Date.UTC(2026, 4, 3, 5)),
    wonAt: new Date(Date.UTC(2026, 4, 9, 6)),
    value: 20_000,
  });
  await rollupDays(h.pool, [...days(1, 15), "2026-05-09"], TZ);
});
afterAll(async () => h.close());

describe("Leads: are leads coming in as usual today?", () => {
  it("counts today's arrivals as Analytics does, and the hours add up to the number", async () => {
    const t = (await tiles(owner)).leads!;
    // a, b, c, and the one dated today (typed in last night); not yesterday's, not the deleted one.
    expect(t.today).toBe(4);
    expect(t.hours.reduce((x, y) => x + y, 0)).toBe(t.today);
    expect(t.hours[0]).toBe(1); // dated today, entered before today began
    expect(t.hours[9]).toBe(1);
    expect(t.hours[10]).toBe(2);
  });
  it("compares with last Monday by this time, not the whole of last Monday", async () => {
    expect((await tiles(owner)).leads!.lastWeek).toBe(1);
  });
  it("shows a usual day only from weekdays LUME was already in use, and only with two or more of them", async () => {
    const t = (await tiles(owner)).leads!;
    // June 8 and June 1 are counted; May 25 and May 18 are before LUME's first lead.
    expect(t.weeks).toBe(2);
    expect(t.usual![10]).toBe(1); // June 8 at 10 and June 1 at 10: one a week, on average
    expect(t.usual![15]).toBe(0.5);
  });
  it("says how many were reached, and the median minutes only from three or more", async () => {
    const t = (await tiles(owner)).leads!;
    expect(t.reached).toBe(3);
    expect(t.medianMinutes).toBe(20);
  });
  it("is the viewer's own leads at own scope", async () => {
    const t = (await tiles(rep)).leads!;
    expect(t.today).toBe(1);
    expect(t.medianMinutes).toBeNull();
  });
});

describe("The month: what's been won, against the same days of last month", () => {
  it("is revenue for someone with the money permission, against the same days of May", async () => {
    const m = (await tiles(owner)).month!;
    expect(m.money).toBe(true);
    expect(m.value).toBe(50_000);
    expect(m.previous).toBe(20_000);
    expect(m.goal).toBeNull();
  });
  it("is deals won without the money permission, and the goal is the viewer's own first, else the business's", async () => {
    expect((await tiles(rep)).month).toMatchObject({ money: false, value: 0, goal: null });
    const set = async (scope: string, scopeId: string | null, metric: string, target: number) =>
      h.queryAll(
        `INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'month', '2026-06-01', $4, $5)`,
        [scope, scopeId, metric, target, owner.id],
      );
    await set("business", null, "revenue", 200_000);
    await set("user", rep.id, "won", 4);
    expect((await tiles(owner)).month!.goal).toMatchObject({
      scope: "business",
      target: 200_000,
      value: 50_000,
    });
    expect((await tiles(rep)).month!.goal).toMatchObject({ scope: "user", target: 4, value: 0 });
    await h.queryAll("DELETE FROM goals");
  });
});

describe("The pipeline right now", () => {
  it("is the default pipeline's open stages in order, from the kept counts, at the viewer's reach", async () => {
    const p = (await tiles(owner)).pipeline!;
    expect(p.many).toBe(false);
    // Every lead seeded open and not deleted is in the first stage ("New").
    const all = p.stages.reduce((x, y) => x + y.n, 0);
    expect(p.open).toBe(all);
    expect(p.stages[0]!.n).toBe(all);
    expect(p.wonThisMonth).toBe(1);
    expect((await tiles(rep)).pipeline!.open).toBe(1);
  });
  it("has a forecast only with the money permission, counted as Analytics counts it", async () => {
    const rows = (await h.queryAll(
      `SELECT sum(l.value * coalesce(s.win_probability, 0) / 100)::float8 AS v FROM leads l JOIN stages s ON s.id = l.stage_id
       WHERE s.kind = 'open' AND l.deleted_at IS NULL AND l.value IS NOT NULL`,
    )) as { v: number }[];
    const v = rows[0]!.v;
    expect((await tiles(owner)).pipeline!.forecast).toBe(v);
    expect((await tiles(rep)).pipeline!.forecast).toBeNull();
  });
  it("has no forecast when no stage has a win probability", async () => {
    await h.queryAll("UPDATE stages SET win_probability = NULL WHERE kind = 'open'");
    expect((await tiles(owner)).pipeline!.forecast).toBeNull();
  });
});

describe("Calls: the viewer's own, today and this week", () => {
  it("counts today's calls that still stand, which were held, and the week Monday to Sunday", async () => {
    const c = (await tiles(owner)).calendar;
    expect(c.todayIndex).toBe(0); // Monday
    expect(c.today).toBe(2); // held + scheduled; the cancelled one isn't a call
    expect(c.held).toBe(1);
    expect(c.week).toEqual([2, 0, 1, 0, 0, 0, 0]);
    expect((await tiles(rep)).calendar.today).toBe(1);
  });
  it("starts the week on the business's own first day", async () => {
    await h.ownerPool.query("UPDATE settings SET week_start = 0 WHERE id = 1");
    const c = (await tiles(owner)).calendar;
    expect(c.todayIndex).toBe(1); // Sunday first: Monday is the second column
    expect(c.week).toEqual([0, 2, 0, 1, 0, 0, 0]);
    await h.ownerPool.query("UPDATE settings SET week_start = 1 WHERE id = 1");
  });
});

describe("The team, or one's own streak", () => {
  it("shows whose follow-ups are overdue right now to someone who sees the team", async () => {
    const t = await tiles(owner);
    expect(t.streak).toBeUndefined();
    expect(t.team!.overdue).toBe(3);
    expect(t.team!.people[0]).toMatchObject({ name: "Maya Kapoor", n: 2 });
    expect(t.team!.onTime).toBeNull(); // fewer than ten done this month: nothing to say yet
  });
  it("gives someone who sees only their own the days in a row they kept every follow-up", async () => {
    const t = await tiles(rep);
    expect(t.team).toBeUndefined();
    // Back from yesterday: Sunday on time (1); Saturday's was late — the run ends. Friday had nothing due.
    expect(t.streak).toMatchObject({ days: 1, dueToday: 2, doneToday: 0 });
    expect(t.streak!.last7).toEqual(["ok", "missed", "ok"]);
  });
});

describe("Replies", () => {
  it("is the Overview's reply rate for the last 7 days, with its days", async () => {
    const t = (await tiles(owner)).replies!;
    const g = (
      await (await h.signIn(owner)).inject({ method: "GET", url: "/api/v1/analytics/glance" })
    ).json() as { kpis: { id: string; value: number | null; series: unknown[] }[] };
    const k = g.kpis.find((x) => x.id === "reply_rate")!;
    expect(t.rate).toBe(k.value);
    expect(t.series).toEqual(k.series);
    expect(t.best).toBeNull(); // no template sent ten times
  });
});

describe("Permissions", () => {
  it("leaves out every tile the viewer may not see", async () => {
    const t = await tiles(plain);
    expect(t.month).toBeUndefined();
    expect(t.team).toBeUndefined();
    expect(t.replies).toBeUndefined();
    expect(t.leads).toBeDefined();
    expect(t.calendar).toBeDefined();
    expect(t.streak).toBeDefined();
  });
});
