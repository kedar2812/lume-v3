import { ALL_GRANTS, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../harness";

/**
 * Phase 7: LUME at the owner's "Large" scale — a year of made-up leads (generic, fictional), timed through the
 * real API code. Skipped unless LUME_SCALE is set (it seeds for minutes): `LUME_SCALE=1000000 vitest run
 * apps/api/test/scale`. Prints each path's median time; the spec's targets come from these numbers.
 */
const N = Number(process.env.LUME_SCALE ?? 0);
// The disk-backed scale database (`scripts/test-db.sh scale-up`), when there is one: the test database is a small
// tmpfs, fine for tests, too small for a year of leads.
if (N && process.env.SCALE_DATABASE_URL)
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith("SCALE_") && v) process.env[`TEST_${k.slice(6)}`] = v;
const PEOPLE = 50;
const RUNS = 5;

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let lead: AuthedClient;
const timings: { path: string; ms: number; rows?: number }[] = [];

const sales: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
  { key: "leads.edit", scope: "own" },
];

async function time(path: string, call: () => Promise<{ statusCode: number; body: string }>) {
  const ms: number[] = [];
  let rows: number | undefined;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const r = await call();
    ms.push(performance.now() - t);
    expect(r.statusCode, `${path}: ${r.body.slice(0, 300)}`).toBeLessThan(300);
    const j = JSON.parse(r.body || "{}");
    rows = j.items?.length ?? j.total ?? rows;
  }
  ms.sort((a, b) => a - b);
  timings.push({ path, ms: Math.round(ms[Math.floor(RUNS / 2)]!), ...(rows !== undefined ? { rows } : {}) });
}

describe.skipIf(!N)(`LUME at scale: ${N.toLocaleString("en-US")} leads`, () => {
  beforeAll(async () => {
    h = await createHarness({ preset: "general" });
    await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
    const adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
    admin = await h.signIn(adminUser);
    const people: SeededUser[] = [];
    for (let i = 0; i < PEOPLE; i++)
      people.push(await h.seedUser({ grants: sales, name: `Person ${i + 1}` }));
    rep = await h.signIn(people[0]!);
    const teamLead = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "team" },
        { key: "leads.contact.reveal", scope: "team" },
      ],
      name: "Team Lead",
    });
    await h.seedTeam(
      teamLead.id,
      people.slice(0, 10).map((p) => p.id),
    );
    lead = await h.signIn(teamLead);

    const started = performance.now();
    await h.ownerPool.query("SET statement_timeout = 0");
    // Ten tags; a year of leads spread over 50 people (5% unassigned), stages weighted like a real funnel.
    await h.queryAll(
      `INSERT INTO tags (id, label) SELECT gen_random_uuid(), 'Tag ' || g FROM generate_series(1, 10) g`,
    );
    // In batches of 10,000, each its own transaction: one huge insert outgrows a small test database's memory.
    const BATCH = 10_000;
    for (let from = 1; from <= N; from += BATCH) {
      const to = Math.min(N, from + BATCH - 1);
      const made = await h.queryAll<{ id: string }>(
        `WITH st AS (
         SELECT array_agg(s.id ORDER BY s.position) FILTER (WHERE s.kind = 'open') AS open,
                array_agg(s.id) FILTER (WHERE s.kind = 'won') AS won,
                array_agg(s.id) FILTER (WHERE s.kind = 'lost') AS lost,
                (SELECT id FROM pipelines WHERE is_default) AS pipeline
           FROM stages s JOIN pipelines p ON p.id = s.pipeline_id AND p.is_default WHERE s.archived_at IS NULL
       ), owners AS (SELECT array_agg(id) AS ids FROM users WHERE name LIKE 'Person %'),
       names AS (
         SELECT ARRAY['Aisha','Omar','Lina','Karim','Noor','Sara','Dana','Rami','Maya','Yusuf','Hana','Tariq',
                      'Leila','Sami','Rania','Ziad','Farah','Adam','Nadia','Bilal'] AS first,
                ARRAY['Haddad','Khan','Farah','Aziz','Saleh','Nair','Lowe','Rahim','Faris','Ito',
                      'Okafor','Reid','Lal','Rao','Mehta','Park','Ellis','Sayed','Karam','Hale'] AS last
       )
       INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_raw, phone_e164, phone_country_iso,
                          phone_status, email, value, currency, lead_created_at, created_at, updated_at,
                          last_activity_at, stage_entered_at)
       SELECT gen_random_uuid(), st.pipeline,
              CASE WHEN r < 0.6 THEN st.open[1 + (g % array_length(st.open, 1))]
                   WHEN r < 0.85 THEN st.lost[1] ELSE st.won[1] END,
              CASE WHEN g % 20 = 0 THEN NULL ELSE owners.ids[1 + (g % $1)] END,
              names.first[1 + (g % 20)] || ' ' || names.last[1 + ((g / 20) % 20)],
              '+9715' || lpad((g % 100000000)::text, 8, '0'), '+9715' || lpad((g % 100000000)::text, 8, '0'), 'AE',
              'valid',
              lower(names.first[1 + (g % 20)]) || '.' || lower(names.last[1 + ((g / 20) % 20)]) || g || '@example.com',
              CASE WHEN g % 3 = 0 THEN (g % 50000)::numeric ELSE NULL END, 'AED',
              (now() - make_interval(secs => (g::float / $2) * 365 * 86400))::date,
              now() - make_interval(secs => (g::float / $2) * 365 * 86400),
              now() - make_interval(secs => (g::float / $2) * 300 * 86400),
              now() - make_interval(secs => (g::float / $2) * 300 * 86400),
              now() - make_interval(secs => (g::float / $2) * 300 * 86400)
         FROM generate_series($3::int, $4::int) g, LATERAL (SELECT random() AS r) x, st, owners, names
         RETURNING id`,
        [PEOPLE, N, from, to],
      );
      // About 40% of leads carry one or two tags.
      await h.queryAll(
        `WITH t AS (SELECT array_agg(id ORDER BY label) AS ids FROM tags)
         INSERT INTO lead_tags (lead_id, tag_id)
         SELECT x, t.ids[1 + (abs(hashtext(x::text)) % 10)] FROM unnest($1::uuid[]) x, t WHERE abs(hashtext(x::text)) % 5 < 2
         UNION
         SELECT x, t.ids[1 + (abs(hashtext(x::text || 'b')) % 10)] FROM unnest($1::uuid[]) x, t WHERE abs(hashtext(x::text)) % 10 = 0`,
        [made.map((m) => m.id)],
      );
    }
    await h.ownerPool.query("ANALYZE");
    timings.push({ path: "seed (insert + tags + analyze)", ms: Math.round(performance.now() - started) });
  }, 3_600_000);

  afterAll(async () => {
    console.table(timings);
    await h?.close();
  });

  it("times every main path", async () => {
    const cfg = await h.config();
    const stage = Object.values(cfg.stages)[1]!;
    const tag = (await h.queryAll<{ id: string }>("SELECT id FROM tags ORDER BY label LIMIT 1"))[0]!.id;
    const owner = (await h.queryAll<{ id: string }>("SELECT id FROM users WHERE name = 'Person 7'"))[0]!.id;
    const get = (c: AuthedClient, url: string) => () => c.inject({ method: "GET", url });

    await time("admin list newest", get(admin, "/api/v1/leads?limit=50"));
    await time("admin list by name", get(admin, "/api/v1/leads?limit=50&sort=name"));
    await time("admin list updated", get(admin, "/api/v1/leads?limit=50&sort=updated"));
    await time("admin list oldest", get(admin, "/api/v1/leads?limit=50&sort=oldest"));
    const first = (await admin.inject({ method: "GET", url: "/api/v1/leads?limit=50" })).json();
    await time(
      "admin list page 2 (cursor)",
      get(admin, `/api/v1/leads?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`),
    );
    await time("admin filter stage", get(admin, `/api/v1/leads?limit=50&stageId=${stage}`));
    await time("admin filter owner", get(admin, `/api/v1/leads?limit=50&ownerId=${owner}`));
    await time(
      "admin filter owner+stage",
      get(admin, `/api/v1/leads?limit=50&ownerId=${owner}&stageId=${stage}`),
    );
    await time("admin filter tag", get(admin, `/api/v1/leads?limit=50&tagId=${tag}`));
    await time("admin filter unassigned", get(admin, "/api/v1/leads?limit=50&ownerId=none"));
    await time("admin search name", get(admin, "/api/v1/leads?limit=50&q=Lina%20Faris"));
    await time("admin search phone", get(admin, "/api/v1/leads?limit=50&q=501234"));
    await time("admin search email", get(admin, "/api/v1/leads?limit=50&q=omar.khan77"));
    await time("admin search rare (no match)", get(admin, "/api/v1/leads?limit=50&q=Zzyzx"));
    await time("admin counts (stage strip)", get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}`));
    await time(
      "admin counts + stage filter",
      get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&ownerId=${owner}`),
    );
    await time("rep list (own)", get(rep, "/api/v1/leads?limit=50"));
    await time("rep counts (own)", get(rep, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}`));
    await time("rep search (own)", get(rep, "/api/v1/leads?limit=50&q=Lina"));
    await time("team lead list (10 people)", get(lead, "/api/v1/leads?limit=50"));
    await time("team lead counts", get(lead, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}`));

    // Bulk at today's ceiling of 100, on the newest leads.
    const ids = (first.items as { id: string }[])
      .concat(
        (
          await admin.inject({
            method: "GET",
            url: `/api/v1/leads?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`,
          })
        ).json().items,
      )
      .map((l: { id: string }) => l.id);
    const bulk = async (action: Record<string, unknown>) => {
      const t = performance.now();
      const r = await admin.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: { ids, action } });
      expect(r.statusCode, r.body).toBeLessThan(300);
      return Math.round(performance.now() - t);
    };
    timings.push({ path: "bulk assign 100", ms: await bulk({ type: "assign", ownerId: owner }) });
    timings.push({ path: "bulk stage 100", ms: await bulk({ type: "stage", stageId: stage }) });
    timings.push({ path: "bulk tag 100", ms: await bulk({ type: "tags", add: [tag] }) });

    // Export at its cap (25,000), the way the Leads list asks.
    const t = performance.now();
    const ex = await admin.inject({
      method: "POST",
      url: "/api/v1/leads/export",
      payload: {
        format: "csv",
        label: "Scale",
        filters: { ownerId: owner },
        columns: ["name", "stage", "owner", "phone", "email", "tags"],
      },
    });
    timings.push({ path: `export (owner filter) → ${ex.statusCode}`, ms: Math.round(performance.now() - t) });
  }, 3_600_000);

  it("explains the slow paths (query plans, printed)", async () => {
    if (!process.env.LUME_SCALE_EXPLAIN) return;
    const cfg = await h.config();
    const repId = (await h.queryAll<{ id: string }>("SELECT id FROM users WHERE name = 'Person 1'"))[0]!.id;
    const tag = (await h.queryAll<{ id: string }>("SELECT id FROM tags ORDER BY label LIMIT 1"))[0]!.id;
    /** An EXPLAIN statement, run as a person of this scope would run it: row-level security applies (FORCE). */
    const explain = async (title: string, scope: "all" | "own", text: string, params: unknown[] = []) => {
      const c = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true)",
          [repId, scope],
        );
        const r = await c.query(text, params);
        await c.query("ROLLBACK");
        console.log(`\n=== ${title}\n${r.rows.map((x) => x["QUERY PLAN"]).join("\n")}`);
      } finally {
        c.release();
      }
    };
    const counts =
      "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT stage_id, count(*) FROM leads WHERE deleted_at IS NULL AND pipeline_id = $1 GROUP BY stage_id";
    await explain("rep counts (own)", "own", counts, [cfg.pipelineId]);
    await explain("admin counts", "all", counts, [cfg.pipelineId]);
    await explain(
      "admin search rare",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL AND (name ILIKE '%Zzyzx%' OR email::text ILIKE '%Zzyzx%'
         OR instagram_handle::text ILIKE '%Zzyzx%') ORDER BY id DESC LIMIT 51`,
    );
    await explain(
      "admin sort by name",
      "all",
      "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL ORDER BY lower(name), id LIMIT 51",
    );
    await explain(
      "admin filter tag",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads l WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag_id = $1)
        ORDER BY id DESC LIMIT 51`,
      [tag],
    );
    await explain(
      "rep list (own)",
      "own",
      "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 51",
    );
  }, 600_000);
});
