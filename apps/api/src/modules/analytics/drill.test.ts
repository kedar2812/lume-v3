import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
const set = async (id: string, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  await h.queryAll(`UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [
    id,
    ...Object.values(cols),
  ]);
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
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  const src = (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Fair') RETURNING id",
    )
  ).rows[0].id as string;
  const [reason] = await h.queryAll<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 1");
  for (let i = 0; i < 4; i++) {
    const id = await h.seedLead({ ownerId: rep.id });
    await set(id, { created_at: `2026-06-0${i + 1}T05:00:00Z`, source_id: src });
    if (i === 0) await set(id, { lost_at: "2026-06-10T05:00:00Z", lost_reason_id: reason!.id });
  }
  // One from nowhere in particular: its row has no source.
  await set(await h.seedLead({ ownerId: rep.id }), { created_at: "2026-06-05T05:00:00Z" });
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

const open = async (u: SeededUser, token: string) =>
  (await h.signIn(u)).inject({
    method: "GET",
    url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}`,
  });

describe("drill tokens for any number (8D-1 Task 1)", () => {
  it("each source row opens exactly the leads it counts, and the ones won", async () => {
    const s = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })
    ).json();
    for (const row of s.sources) {
      const r = (await open(admin, row.drill.leads)).json();
      expect(r.kind).toBe("source_leads");
      expect(r.total, row.name).toBe(row.leads);
      expect((await open(admin, row.drill.won)).json().total, row.name).toBe(row.won);
    }
    expect(s.sources.find((x: { name: string }) => x.name === "Fair")).toMatchObject({ kind: "manual" });
  });

  it("a lost reason and the stage they left open exactly their leads", async () => {
    const l = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/lost?${Q}` })
    ).json();
    expect(l.reasons[0].n).toBe(1);
    expect((await open(admin, l.reasons[0].drill)).json().total).toBe(1);
    for (const st of l.stages) expect((await open(admin, st.drill)).json().total).toBe(st.n);
    expect((await open(admin, l.wonBack.drill)).json().total).toBe(l.wonBack.n);
  });

  it("someone else's token is not found; an expired one is gone", async () => {
    const s = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })
    ).json();
    const token = s.sources[0].drill.leads;
    expect((await open(rep, token)).statusCode).toBe(404);
    h.clock.advance(16 * 60_000);
    expect((await open(admin, token)).statusCode).toBe(410);
  });
});
