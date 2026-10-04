import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
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
    ],
  });
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
      await h.queryAll("UPDATE leads SET lost_at = $2, lost_reason_id = $3 WHERE id = $1", [
        id,
        new Date(Date.UTC(2026, 5, day + 2, 5)),
        reason,
      ]);
      lostOnes.push(id);
    }
  // Three of them reopened after they were lost; one of those won in June, worth 500.
  for (const [i, id] of lostOnes.slice(0, 3).entries()) {
    const [{ lost_at }] = (await h.queryAll<{ lost_at: Date }>("SELECT lost_at FROM leads WHERE id = $1", [
      id,
    ])) as [{ lost_at: Date }];
    const reopened = new Date(lost_at.getTime() + 86_400_000);
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reopened', $2)",
      [id, reopened],
    );
    if (i === 0)
      await h.queryAll("UPDATE leads SET won_at = $2, value = 500 WHERE id = $1", [
        id,
        new Date(reopened.getTime() + 2 * 86_400_000),
      ]);
  }
  // What converts: a budget question; six said under ₹1 L (two won), six said ₹1–3 L (three won).
  await h.ownerPool.query(
    `INSERT INTO field_definitions (id, key, label, type, options)
     VALUES (gen_random_uuid(), 'budget', 'Budget', 'select', '["Under ₹1 L", "₹1–3 L"]')`,
  );
  for (let i = 0; i < 6; i++) await lead({ day: 10 + i, custom: { budget: "Under ₹1 L" }, won: i < 2 });
  for (let i = 0; i < 6; i++) await lead({ day: 16 + i, custom: { budget: "₹1–3 L" }, won: i < 3 });
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
    expect(cell(r1, s1)).toMatchObject({ n: 4, tooFew: false });
    expect(cell(r1, s2)).toMatchObject({ n: 1, tooFew: true });
    expect(cell(r2, s2)).toMatchObject({ n: 3, tooFew: false });
    for (const c of l.matrix.cells) expect(await opens(c.drill)).toBe(c.n);
  });

  it("the won-back flow: lost, then reopened, then won, and what it brought back", async () => {
    const l = (await get(`lost?${Q}`)).json();
    expect(l.wonBackFlow).toMatchObject({ lost: 8, reopened: 3, won: 1, value: 500 });
  });

  it("what converts: win rate by each answer to a choice field, thin groups marked, each opens its leads", async () => {
    const s = (await get(`segments?${Q}&field=budget`)).json();
    expect(s.field).toMatchObject({ key: "budget", label: "Budget", type: "select" });
    const g = (v: string) => s.groups.find((x: { value: string }) => x.value === v);
    expect(g("Under ₹1 L")).toMatchObject({ arrived: 6, won: 2, tooFew: true });
    expect(g("Under ₹1 L").rate).toBeCloseTo(1 / 3, 6);
    expect(g("₹1–3 L").rate).toBeCloseTo(1 / 2, 6);
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
