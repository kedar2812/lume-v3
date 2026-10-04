import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let plain: SeededUser;
let open: { id: string; name: string }[];
let wonStage: string;
let pipelineId: string;
let srcA: string;
let srcB: string;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
const DAY = 86_400_000;

const move = async (lead: string, from: string, to: string, at: Date) => {
  await h.queryAll(
    "INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at) VALUES ($1, $2, $3, $4, $5)",
    [lead, from, to, pipelineId, at],
  );
  await h.queryAll("UPDATE leads SET stage_id = $2, stage_entered_at = $3 WHERE id = $1", [lead, to, at]);
};

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  plain = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
  const p1 = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
  const p2 = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
  pipelineId = (await h.config()).pipelineId;
  const stages = await h.queryAll<{ id: string; name: string; kind: string }>(
    "SELECT id, name, kind FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position",
    [pipelineId],
  );
  open = stages.filter((s) => s.kind === "open").slice(0, 3);
  wonStage = stages.find((s) => s.kind === "won")!.id;
  // The first three open stages win 10%, 40% and 70% of the time; the first is allowed a day.
  for (const [i, p] of [10, 40, 70].entries())
    await h.queryAll("UPDATE stages SET win_probability = $2, sla_hours = $3 WHERE id = $1", [
      open[i]!.id,
      p,
      i === 0 ? 24 : null,
    ]);
  // Further open stages (if the preset has more) carry no chance of winning, so they add nothing to the forecast.
  await h.queryAll(
    "UPDATE stages SET win_probability = 0 WHERE pipeline_id = $1 AND kind = 'open' AND NOT (id = ANY($2::uuid[]))",
    [pipelineId, open.map((s) => s.id)],
  );
  srcA = (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Fair') RETURNING id",
    )
  ).rows[0].id;
  srcB = (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Website') RETURNING id",
    )
  ).rows[0].id;
  // Fifteen June leads (10 from the fair, 5 from the website), each worth 100: six move on, three of those move on
  // again, and two of those three are won at 1,000.
  for (let i = 0; i < 15; i++) {
    const id = await h.seedLead({ ownerId: i < 8 ? p1.id : p2.id, stage: open[0]!.name });
    const created = new Date(Date.UTC(2026, 5, i + 1, 5));
    await h.queryAll(
      "UPDATE leads SET created_at = $2, stage_entered_at = $2, source_id = $3, value = 100 WHERE id = $1",
      [id, created, i < 10 ? srcA : srcB],
    );
    if (i < 6) await move(id, open[0]!.id, open[1]!.id, new Date(created.getTime() + DAY));
    if (i < 3) await move(id, open[1]!.id, open[2]!.id, new Date(created.getTime() + 2 * DAY));
    if (i < 2) {
      const won = new Date(created.getTime() + 5 * DAY);
      await move(id, open[2]!.id, wonStage, won);
      await h.queryAll("UPDATE leads SET won_at = $2, value = 1000 WHERE id = $1", [id, won]);
    }
    // Of the leads still in the first stage, one has sat there three days (past its allowed day); the rest an hour.
    if (i >= 6)
      await h.queryAll("UPDATE leads SET stage_entered_at = now() - $2::interval WHERE id = $1", [
        id,
        i === 14 ? "3 days" : "1 hour",
      ]);
  }
  // A deleted lead in the third stage, worth a lot: counted nowhere.
  const gone = await h.seedLead({ ownerId: p1.id, stage: open[2]!.name });
  await h.queryAll(
    "UPDATE leads SET created_at = '2026-06-10T05:00:00Z', value = 5000, deleted_at = now() WHERE id = $1",
    [gone],
  );
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

const get = async (u: SeededUser, path: string) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/${path}` })).json();
const openDrill = async (token: string) =>
  (
    await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}`,
    })
  ).json().total;

describe("the funnel's extras (8D-1 Task 4)", () => {
  it("splits by source: each group's own funnel", async () => {
    const f = await get(admin, `funnel?${Q}&split=source`);
    expect(f.split.by).toBe("source");
    const fair = f.split.groups.find((g: { name: string }) => g.name === "Fair");
    expect(fair.arrived).toBe(10);
    expect(fair.stages[0].share).toBe(1);
    expect(fair.stages.find((s: { id: string }) => s.id === open[1]!.id).reached).toBe(6);
  });

  it("each stage now: open leads, their value, how long they've sat; nothing deleted", async () => {
    const f = await get(admin, `funnel?${Q}`);
    const byId = new Map<string, { n: number; value: number | null }>(
      f.now.stages.map((s: { id: string; n: number; value: number | null }) => [s.id, s]),
    );
    expect(byId.get(open[0]!.id)!.n).toBe(9);
    expect(byId.get(open[1]!.id)!.n).toBe(3);
    expect(byId.get(open[2]!.id)!.n).toBe(1);
    expect(byId.get(open[2]!.id)!.value).toBe(100);
    expect(f.now.openN).toBe(13);
    expect(f.now.openValue).toBe(1300);
    for (const s of f.now.stages) expect(await openDrill(s.drill)).toBe(s.n);
  });

  it("time in every open stage, in order, with the allowed time and who's stuck", async () => {
    const f = await get(admin, `funnel?${Q}`);
    expect(f.timeInStage.slice(0, 3).map((s: { id: string }) => s.id)).toEqual(open.map((s) => s.id));
    const first = f.timeInStage[0];
    expect(first).toMatchObject({ slaHours: 24, stuckNow: 1, exited: 6, tooFew: false });
    expect(first.medianMinutes).toBeGreaterThan(0);
    expect(await openDrill(first.drill.stuck)).toBe(1);
    const third = f.timeInStage[2];
    expect(third.exited).toBe(2);
    expect(third.tooFew).toBe(true);
  });

  it("time in stage is narrowed by source (read from the leads): the six who moved on all came from the fair", async () => {
    const plainF = await get(admin, `funnel?${Q}`);
    const fair = await get(admin, `funnel?${Q}&source=${srcA}`);
    const site = await get(admin, `funnel?${Q}&source=${srcB}`);
    expect(fair.timeInStage[0]).toMatchObject({
      exited: 6,
      medianMinutes: plainF.timeInStage[0].medianMinutes,
    });
    expect(fair.timeInStage[1].exited).toBe(plainF.timeInStage[1].exited);
    expect(site.timeInStage[0]).toMatchObject({ exited: 0, medianMinutes: null });
    // Stuck now: the lead three days in the first stage came from the website.
    expect(site.timeInStage[0].stuckNow).toBe(1);
    expect(fair.timeInStage[0].stuckNow).toBe(0);
    expect(fair.timeInStageNote ?? null).toBeNull();
  });

  it("over 92 days a source can't narrow time in stage, and the board says so instead of counting every source", async () => {
    const f = await get(admin, `funnel?range=custom&from=2026-01-01&to=2026-06-30&source=${srcB}`);
    expect(f.timeInStage).toEqual([]);
    expect(f.timeInStageNote).toBe(
      "Time in stage can be narrowed by source for up to 92 days. Pick a shorter range to see it.",
    );
    // Without a source, it's counted from the rollups as ever.
    expect(
      (await get(admin, "funnel?range=custom&from=2026-01-01&to=2026-06-30")).timeInStage[0].exited,
    ).toBe(6);
  });

  it("each stage's reached and stopped numbers open exactly their leads", async () => {
    const f = await get(admin, `funnel?${Q}`);
    for (const s of f.stages) {
      expect(await openDrill(s.drill.reached), s.name).toBe(s.reached);
      expect(await openDrill(s.drill.stopped), s.name).toBe(s.stoppedN);
    }
  });

  it("velocity is open leads × win rate × average deal ÷ days to win", async () => {
    const f = await get(admin, `funnel?${Q}`);
    const v = f.velocity;
    expect(v).toMatchObject({ openLeads: 13, winRate: 1, avgDeal: 1000 });
    expect(v.cycleDays).toBeCloseTo(5, 6);
    expect(v.perDay).toBeCloseTo((13 * 1 * 1000) / 5, 6);
  });

  it("the forecast by month adds up to the forecast tile", async () => {
    const f = await get(admin, `funnel?${Q}`);
    const o = await get(admin, `overview?${Q}`);
    const tile = o.tiles.find((t: { id: string }) => t.id === "forecast").value;
    const sum =
      f.forecast.months.reduce(
        (a: number, m: { latest: number; second: number; earlier: number }) =>
          a + m.latest + m.second + m.earlier,
        0,
      ) + f.forecast.later;
    expect(sum).toBeCloseTo(tile, 2);
    expect(f.forecast.months).toHaveLength(3);
  });

  it("under a tag every lead carries, the live funnel equals the rollups'", async () => {
    const tag = (
      await h.ownerPool.query("INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'all') RETURNING id")
    ).rows[0].id as string;
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) SELECT id, $1 FROM leads", [tag]);
    // One lead moved back a stage: where it stands now is no longer the furthest it got.
    const [back] = await h.queryAll<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM leads WHERE stage_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      [open[1]!.id],
    );
    await move(back!.id, open[1]!.id, open[0]!.id, new Date(back!.created_at.getTime() + 3 * DAY));
    await rollupDays(h.pool, days, TZ);
    const plainF = await get(admin, `funnel?${Q}&split=source`);
    const liveF = await get(admin, `funnel?${Q}&split=source&tag=${tag}`);
    expect(liveF.arrived).toBe(plainF.arrived);
    const pick = (f: { stages: { id: string; reached: number; stoppedN: number }[] }) =>
      f.stages.map((s) => [s.id, s.reached, s.stoppedN]);
    expect(pick(liveF)).toEqual(pick(plainF));
    expect(liveF.split).toEqual(plainF.split);
    expect(liveF.now.openN).toBe(plainF.now.openN);
    const stays = (f: { timeInStage: { id: string; exited: number; medianMinutes: number | null }[] }) =>
      f.timeInStage.map((s) => [s.id, s.exited, s.medianMinutes]);
    expect(stays(liveF)).toEqual(stays(plainF));
  });

  it("without the revenue permission: no money anywhere", async () => {
    const f = await get(plain, `funnel?${Q}`);
    expect(f.velocity).toBeNull();
    expect(f.forecast).toBeNull();
    expect(f.now.openValue).toBeNull();
    for (const s of f.now.stages) expect(s).not.toHaveProperty("value");
  });
});
