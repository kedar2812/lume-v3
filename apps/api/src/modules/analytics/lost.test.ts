import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { dayOf } from "@lume/core";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
let r1: string;
let r2: string;
let s1: string;
let s2: string;
let st: { open: string; lost: string; won: string; pipeline: string };
// A stage move as LUME's writer leaves it (leads/write.ts): history at that moment, the lead's dates to match.
const move = (id: string, from: string | null, to: string, at: Date) =>
  h.queryAll(
    "INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, pipeline_id, changed_at) VALUES ($1, $2, $3, $4, $5)",
    [id, from, to, st.pipeline, at],
  );

const source = async (name: string) => {
  const id = randomUUID();
  await h.ownerPool.query("INSERT INTO lead_sources (id, type, name) VALUES ($1, 'manual', $2)", [id, name]);
  return id;
};
const lead = async (o: { day: number; source?: string; custom?: object; won?: boolean }) => {
  const id = await h.seedLead({ ownerId: admin.id });
  const created = new Date(Date.UTC(2026, 5, o.day, 5));
  await h.queryAll(
    "UPDATE leads SET created_at = $2, source_id = $3, custom = $4::jsonb, won_at = $5 WHERE id = $1",
    [
      id,
      created,
      o.source ?? null,
      JSON.stringify(o.custom ?? {}),
      o.won ? new Date(created.getTime() + 2 * 86_400_000) : null,
    ],
  );
  return id;
};

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
      { key: "leads.change_stage", scope: "all" },
    ],
  });
  const stages = await h.queryAll<{ id: string; kind: string; pipeline_id: string }>(
    "SELECT id, kind, pipeline_id FROM stages WHERE pipeline_id = (SELECT id FROM pipelines ORDER BY position LIMIT 1) ORDER BY position",
  );
  st = {
    open: stages.find((x) => x.kind === "open")!.id,
    lost: stages.find((x) => x.kind === "lost")!.id,
    won: stages.find((x) => x.kind === "won")!.id,
    pipeline: stages[0]!.pipeline_id,
  };
  [r1, r2] = (await h.queryAll<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 2")).map(
    (r) => r.id,
  ) as [string, string];
  s1 = await source("Fair");
  s2 = await source("Website");
  // Eight lost in June: reason 1 × fair 4, reason 1 × website 1, reason 2 × website 3.
  const lostOnes: string[] = [];
  const cells: [string, string, number][] = [
    [r1, s1, 4],
    [r1, s2, 1],
    [r2, s2, 3],
  ];
  let day = 1;
  for (const [reason, src, n] of cells)
    for (let i = 0; i < n; i++) {
      const id = await lead({ day: day++, source: src });
      const lostAt = new Date(Date.UTC(2026, 5, day + 2, 5));
      await move(id, st.open, st.lost, lostAt);
      await h.queryAll(
        "UPDATE leads SET stage_id = $4, stage_entered_at = $2, lost_at = $2, lost_reason_id = $3 WHERE id = $1",
        [id, lostAt, reason, st.lost],
      );
      lostOnes.push(id);
    }
  // Three of the fair's "reason 1" leads reopened after they were lost, which clears the loss (as the writer does);
  // one of those won in June, worth 500.
  for (const [i, id] of lostOnes.slice(0, 3).entries()) {
    const [{ lost_at }] = (await h.queryAll<{ lost_at: Date }>("SELECT lost_at FROM leads WHERE id = $1", [
      id,
    ])) as [{ lost_at: Date }];
    const reopened = new Date(lost_at.getTime() + 86_400_000);
    await move(id, st.lost, st.open, reopened);
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reopened', $2)",
      [id, reopened],
    );
    await h.queryAll(
      "UPDATE leads SET stage_id = $3, stage_entered_at = $2, lost_at = NULL, lost_reason_id = NULL WHERE id = $1",
      [id, reopened, st.open],
    );
    if (i === 0) {
      const wonAt = new Date(reopened.getTime() + 2 * 86_400_000);
      await move(id, st.open, st.won, wonAt);
      await h.queryAll(
        "UPDATE leads SET stage_id = $3, stage_entered_at = $2, won_at = $2, value = 500 WHERE id = $1",
        [id, wonAt, st.won],
      );
    }
  }
  // What converts: a budget question; six said under ₹1 L (two won), six said ₹1–3 L (three won).
  await h.ownerPool.query(
    `INSERT INTO field_definitions (id, key, label, type, options)
     VALUES (gen_random_uuid(), 'budget', 'Budget', 'select',
             '[{"id": "o-mid", "label": "₹1–3 L"}, {"id": "o-low", "label": "Under ₹1 L"}]')`,
  );
  for (let i = 0; i < 6; i++) await lead({ day: 10 + i, custom: { budget: "o-low" }, won: i < 2 });
  for (let i = 0; i < 6; i++) await lead({ day: 16 + i, custom: { budget: "o-mid" }, won: i < 3 });
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

const get = async (path: string) =>
  (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/${path}` });
const opens = async (token: string) =>
  (await get(`drilldown?token=${encodeURIComponent(token)}`)).json().total as number;

describe("lost, won back, what converts (8D-1 Task 6)", () => {
  it("reasons by source: each cell's count, thin cells marked, each opens its leads", async () => {
    const l = (await get(`lost?${Q}`)).json();
    const cell = (reason: string, src: string) =>
      l.matrix.cells.find(
        (c: { reasonId: string; sourceId: string }) => c.reasonId === reason && c.sourceId === src,
      );
    // Still lost: three of the fair's four came back.
    expect(cell(r1, s1)).toMatchObject({ n: 1, tooFew: true });
    expect(cell(r1, s2)).toMatchObject({ n: 1, tooFew: true });
    expect(cell(r2, s2)).toMatchObject({ n: 3, tooFew: false });
    for (const c of l.matrix.cells) expect(await opens(c.drill)).toBe(c.n);
  });

  it("the won-back flow: every lead lost in the span, those reopened since, those then won, and what it brought back", async () => {
    const l = (await get(`lost?${Q}`)).json();
    // The board's reasons count leads still lost; the flow starts from every loss in the span.
    expect(l.total).toBe(5);
    expect(l.wonBackFlow).toMatchObject({ lost: 8, reopened: 3, won: 1, value: 500 });
    expect(await opens(l.wonBackFlow.drill)).toBe(1);
  });

  it("through LUME's own stage moves: lost with a reason, reopened, won — the flow counts it", async () => {
    const c = await h.signIn(admin);
    const id = await h.seedLead({ ownerId: admin.id });
    const to = (stageId: string, extra: object = {}) =>
      c.inject({ method: "POST", url: `/api/v1/leads/${id}/stage`, payload: { stageId, ...extra } });
    expect((await to(st.lost, { lostReasonId: r2 })).statusCode).toBe(200);
    expect((await to(st.open)).statusCode).toBe(200);
    expect((await to(st.won)).statusCode).toBe(200);
    // The moves were stamped now; read today in the business's time zone.
    h.clock.now = new Date(Date.now() + 60_000);
    const today = dayOf(h.clock.now, TZ);
    const l = (await get(`lost?range=custom&from=${today}&to=${today}`)).json();
    expect(l.total).toBe(0);
    expect(l.wonBackFlow).toMatchObject({ lost: 1, reopened: 1, won: 1 });
    expect(l.wonBack.n).toBe(1);
    expect(await opens(l.wonBackFlow.drill)).toBe(1);
  });

  it("what converts: win rate by each answer to a choice field, thin groups marked, each opens its leads", async () => {
    const s = (await get(`segments?${Q}&field=budget`)).json();
    expect(s.field).toMatchObject({ key: "budget", label: "Budget", type: "select" });
    const g = (v: string) => s.groups.find((x: { value: string }) => x.value === v);
    // Each answer by its option's label, in the field's own order.
    expect(s.groups.map((x: { label: string }) => x.label)).toEqual(["₹1–3 L", "Under ₹1 L", "Not answered"]);
    expect(g("o-low")).toMatchObject({ label: "Under ₹1 L", arrived: 6, won: 2, tooFew: true });
    expect(g("o-low").rate).toBeCloseTo(1 / 3, 6);
    expect(g("o-mid").rate).toBeCloseTo(1 / 2, 6);
    for (const x of s.groups.filter((x: { value: string | null }) => x.value !== null))
      expect(await opens(x.drill)).toBe(x.arrived);
    expect(s.fields.map((f: { key: string }) => f.key)).toContain("budget");
  });

  it("under a tag every lead carries, lost reads live and agrees with the rollups", async () => {
    const tag = (
      await h.ownerPool.query("INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'all') RETURNING id")
    ).rows[0].id as string;
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) SELECT id, $1 FROM leads", [tag]);
    const plain = (await get(`lost?${Q}`)).json();
    const live = (await get(`lost?${Q}&tag=${tag}`)).json();
    expect(live.total).toBe(plain.total);
    expect(live.owners).toEqual(plain.owners);
    expect(live.matrix.cells.map((c: { n: number }) => c.n)).toEqual(
      plain.matrix.cells.map((c: { n: number }) => c.n),
    );
    expect(live.wonBackFlow).toMatchObject({ lost: 8, reopened: 3, won: 1 });
  });

  it("what converts reads each lead, so over 92 days it's refused; a field that isn't a choice is refused", async () => {
    const long = await get("segments?range=custom&from=2026-02-01&to=2026-06-30&field=budget");
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe("RANGE_TOO_LONG_FOR_FILTER");
    const bad = await get(`segments?${Q}&field=nonesuch`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_FIELD");
  });
});
