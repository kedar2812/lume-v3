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

  it(
    "a big team's numbers open from a short link: the token names the team or the viewer's reach, not every person",
    { timeout: 120_000 },
    async () => {
      // A team of 120: the rep, their lead and 118 more.
      const lead = await h.seedUser({
        grants: [
          { key: "analytics.view", scope: "team" },
          { key: "leads.view", scope: "team" },
        ],
      });
      const team = (
        await h.ownerPool.query(
          "INSERT INTO teams (id, name) VALUES (gen_random_uuid(), 'Everyone') RETURNING id",
        )
      ).rows[0].id as string;
      const others = [];
      for (let i = 0; i < 118; i++) others.push((await h.seedUser({ grants: [] })).id);
      for (const m of [rep.id, lead.id, ...others])
        await h.ownerPool.query("INSERT INTO team_members (team_id, user_id, is_lead) VALUES ($1, $2, $3)", [
          team,
          m,
          m === lead.id,
        ]);
      const tokenOf = async (u: SeededUser, q: string) =>
        (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/overview?${q}` })).json()
          .drill.new_leads as string;
      for (const [u, q] of [
        [lead, Q],
        [admin, `${Q}&team=${team}`],
      ] as const) {
        const token = await tokenOf(u, q);
        expect(token.length).toBeLessThan(1000);
        const r = await open(u, token);
        expect(r.statusCode).toBe(200);
        expect(r.json().total).toBe(5);
      }
    },
  );

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

describe("a number behind more leads than a list holds (8D-1 final review)", () => {
  it(
    "over 10,000 leads: the sheet says it shows the first 10,000; Leads and exports refuse rather than cut it short",
    { timeout: 120_000 },
    async () => {
      const one = await h.seedLead({ ownerId: rep.id });
      await h.queryAll(
        `INSERT INTO leads (id, pipeline_id, stage_id, stage_entered_at, owner_id, name, created_at)
       SELECT gen_random_uuid(), l.pipeline_id, l.stage_id, l.stage_entered_at, l.owner_id, l.name, '2026-06-20T05:00:00Z'
       FROM leads l, generate_series(1, 10001) WHERE l.id = $1`,
        [one],
      );
      await rollupDays(h.pool, ["2026-06-20"], TZ);
      const c = await h.signIn(admin);
      const token = (await c.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })).json().drill
        .new_leads as string;
      const sheet = (await open(admin, token)).json();
      expect(sheet).toMatchObject({ total: 10_000, capped: true });
      const pipelineId = (await h.config()).pipelineId;
      for (const url of [
        `/api/v1/leads?drill=${token}`,
        `/api/v1/leads/counts?pipelineId=${pipelineId}&drill=${token}`,
      ]) {
        const r = await c.inject({ method: "GET", url });
        expect([url, r.statusCode]).toEqual([url, 400]);
        expect(r.json().error).toEqual({
          code: "DRILL_TOO_LARGE",
          message:
            "This number covers more than 10,000 leads, too many to open as one list. Narrow the range or a filter.",
        });
      }
      // A number within the limit opens whole, and says so.
      const small = (await c.inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })).json()
        .sources[0];
      expect((await open(admin, small.drill.won)).json().capped).toBe(false);
    },
  );
});
