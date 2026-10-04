import { ALL_GRANTS, STARTER_VIEWS, type Grant } from "@lume/core";
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
  { key: "analytics.view", scope: "own" },
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
       -- Time-ordered ids (UUID v7 layout: the arrival time in the first 48 bits), as the app mints them:
       -- "newest first" and the order the rows sit on disk agree, as they do in a real install.
       SELECT (lpad(to_hex((extract(epoch FROM now() - make_interval(secs => (g::float / $2) * 365 * 86400)) * 1000)::bigint), 12, '0')
                 || '7' || substr(md5(g::text), 1, 3) || '8' || substr(md5(g::text), 4, 15))::uuid, st.pipeline,
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
    // A rare tag on 30 leads: the tag filter must find them without walking every lead (7A review).
    await h.queryAll(
      `WITH t AS (INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'Rare') RETURNING id)
       INSERT INTO lead_tags (lead_id, tag_id) SELECT l.id, t.id FROM (SELECT id FROM leads ORDER BY id LIMIT 30) l, t`,
    );
    // The four starter views a new install has, for the admin and for a rep: the sidebar counts them on every page.
    for (const c of [admin, rep])
      for (const v of STARTER_VIEWS) {
        const r = await c.inject({
          method: "POST",
          url: "/api/v1/views",
          payload: { name: v.name, color: v.color, filters: v.filters },
        });
        expect(r.statusCode, r.body).toBe(201);
      }
    // LUME's minute rollup of the counts, as a live instance would have run it.
    await h.queryAll("SELECT lume_lead_counts_rollup()");
    // VACUUM too: steady state, as autovacuum leaves a live instance (index-only scans need the visibility map).
    await h.ownerPool.query("VACUUM ANALYZE");
    timings.push({
      path: "seed (insert + tags + vacuum analyze)",
      ms: Math.round(performance.now() - started),
    });
  }, 3_600_000);

  afterAll(async () => {
    console.table(timings);
    // One plain line a path too, easy to grep from any runner: SCALE|path|ms|rows.
    for (const t of timings) console.log(`SCALE|${t.path}|${t.ms}|${t.rows ?? ""}`);
    await h?.close();
  });

  it("times every main path", async () => {
    const cfg = await h.config();
    const stage = Object.values(cfg.stages)[1]!;
    const tag = (await h.queryAll<{ id: string }>("SELECT id FROM tags WHERE label = 'Tag 1'"))[0]!.id;
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
    const rare = (await h.queryAll<{ id: string }>("SELECT id FROM tags WHERE label = 'Rare'"))[0]!.id;
    await time("admin filter rare tag (30 leads)", get(admin, `/api/v1/leads?limit=50&tagId=${rare}`));
    const byName = (await admin.inject({ method: "GET", url: "/api/v1/leads?limit=50&sort=name" })).json();
    await time(
      "admin list by name, page 2",
      get(admin, `/api/v1/leads?limit=50&sort=name&cursor=${encodeURIComponent(byName.nextCursor)}`),
    );
    // A common term: past the cap (10% of leads are "Lina …"), newest matches first.
    await time("admin search common (capped)", get(admin, "/api/v1/leads?limit=50&q=Lina"));
    await time("admin counts (stage strip)", get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}`));
    await time(
      "admin counts + owner filter",
      get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&ownerId=${owner}`),
    );
    // Counts with any other filter count live: a tag, a phone status, a search.
    await time(
      "admin counts + tag filter",
      get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&tagId=${tag}`),
    );
    await time(
      "admin counts + phone status",
      get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&phoneStatus=valid`),
    );
    await time(
      "admin counts + search",
      get(admin, `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&q=Lina%20Faris`),
    );
    // The sidebar's saved views (the four a new install starts with), counted on every page.
    await time("admin view counts (sidebar)", get(admin, "/api/v1/views/counts"));
    await time("rep view counts (sidebar)", get(rep, "/api/v1/views/counts"));
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

    // The gate (spec "The gate"): every list, filter, search and count path within the budget at this scale.
    const budget = Number(process.env.LUME_SCALE_BUDGET ?? 150);
    const over = timings.filter((x) => /^(admin|rep|team lead) /.test(x.path) && x.ms > budget);
    expect(over, `over ${budget} ms at ${N.toLocaleString("en-US")} leads`).toEqual([]);
  }, 3_600_000);

  // 8A: analytics reads its daily rollups. Wins and first contacts as a live instance would have them, the last 90
  // days rolled up, then every dashboard timed. Budget: LUME_SCALE_ANALYTICS_BUDGET ms (300 by default).
  it("answers the analytics dashboards from rollups", async () => {
    await h.ownerPool.query("SET statement_timeout = 0");
    let t = performance.now();
    await h.queryAll(`UPDATE leads l SET won_at = l.created_at + interval '6 days'
                      FROM stages s WHERE s.id = l.stage_id AND s.kind = 'won' AND l.created_at > now() - interval '100 days'`);
    await h.queryAll(`INSERT INTO activities (id, lead_id, type, occurred_at)
                      SELECT gen_random_uuid(), id, 'whatsapp_opened', created_at + make_interval(mins => (abs(hashtext(id::text)) % 900))
                      FROM leads WHERE created_at > now() - interval '100 days' AND abs(hashtext(id::text)) % 3 <> 0`);
    timings.push({
      path: "analytics: wins and contacts for 100 days",
      ms: Math.round(performance.now() - t),
    });
    const tz = (
      await h.queryAll<{ tz: string }>("SELECT coalesce(timezone, 'UTC') AS tz FROM settings WHERE id = 1")
    )[0]!.tz;
    const days = (
      await h.queryAll<{ d: string }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series((now() AT TIME ZONE $1)::date - 90, (now() AT TIME ZONE $1)::date, '1 day') d`,
        [tz],
      )
    ).map((r) => r.d);
    t = performance.now();
    for (const d of days) {
      await h.pool.query("SELECT lume_rollup_day($1::date, $2)", [d, tz]);
      await h.pool.query("SELECT lume_rollup_noshow_day($1::date, $2)", [d, tz]);
      await h.pool.query("SELECT lume_rollup_slot_totals($1::date)", [d]);
    }
    timings.push({
      path: `analytics rollup, per day (${days.length} days)`,
      ms: Math.round((performance.now() - t) / days.length),
    });
    await h.ownerPool.query("VACUUM ANALYZE");
    const before = timings.length;
    for (const range of ["30d", "90d"]) {
      for (const m of ["overview", "funnel", "team", "sources", "timing", "lost"])
        await time(`analytics ${m} ${range}`, () =>
          admin.inject({ method: "GET", url: `/api/v1/analytics/${m}?range=${range}` }),
        );
      await time(`analytics rep overview ${range}`, () =>
        rep.inject({ method: "GET", url: `/api/v1/analytics/overview?range=${range}` }),
      );
    }
    const budget = Number(process.env.LUME_SCALE_ANALYTICS_BUDGET ?? 300);
    const over = timings.slice(before).filter((x) => x.ms > budget);
    expect(over, `analytics over ${budget} ms at ${N.toLocaleString("en-US")} leads`).toEqual([]);
  }, 3_600_000);

  // 7B: bulk runs at the owner's "Large" bound — 50,000 leads by filter, queued and run to the end, as the bulk queue
  // runs them. Budget: each action within LUME_SCALE_BULK_BUDGET ms (120 s by default) on the 1-CPU scale database.
  it("runs bulk actions over 50,000 leads by filter, cancels one midway, and undoes one", async () => {
    if (N < 200_000) return;
    const cfg = await h.config();
    const people = await h.queryAll<{ id: string }>(
      "SELECT id FROM users WHERE name LIKE 'Person %' ORDER BY name LIMIT 2",
    );
    const tag = (await h.queryAll<{ id: string }>("SELECT id FROM tags WHERE label = 'Tag 2'"))[0]!.id;
    // The newest quarter of a year of leads: at 200,000 that is just under 50,000.
    const days = Math.floor((365 * 49_000) / N);
    const today = new Date();
    const from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const filters = { createdFrom: from };
    const bulk: { path: string; ms: number; rows?: number }[] = [];
    const run = async (
      label: string,
      action: Record<string, unknown>,
      hooks?: Parameters<Harness["runBulk"]>[0],
    ) => {
      const t = performance.now();
      const r = await admin.inject({
        method: "POST",
        url: "/api/v1/leads/bulk-runs",
        payload: { selection: { filters }, action },
      });
      expect(r.statusCode, r.body).toBe(202);
      await h.runBulk(hooks);
      const done = (
        await admin.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${r.json().run.id}` })
      ).json().run;
      bulk.push({ path: `bulk ${label}`, ms: Math.round(performance.now() - t), rows: done.done });
      return done as { id: string; status: string; done: number; total: number };
    };
    const assigned = await run("assign 50k", { type: "assign", ownerId: people[1]!.id });
    expect(assigned.total).toBeGreaterThan(40_000);
    expect(assigned.total).toBeLessThanOrEqual(50_000);
    // Undo right away: nothing has changed since, so every lead goes back.
    const tu = performance.now();
    const u = await admin.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${assigned.id}/undo` });
    expect(u.statusCode, u.body).toBe(202);
    await h.runBulk();
    const undone = (
      await admin.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${u.json().run.id}` })
    ).json().run;
    bulk.push({
      path: "bulk undo of the 50k assign",
      ms: Math.round(performance.now() - tu),
      rows: undone.done,
    });
    await run("tag 50k", { type: "tags", add: [tag] });
    await run("stage 50k", { type: "stage", stageId: cfg.stages[Object.keys(cfg.stages)[1]!]! });
    const stopped = await run(
      "delete, cancelled after 10 chunks",
      { type: "delete" },
      {
        afterChunk: async (n) => {
          if (n === 9)
            await h.ownerPool.query("UPDATE bulk_runs SET cancel_requested = true WHERE status = 'running'");
        },
      },
    );
    expect(stopped.status).toBe("cancelled");
    for (const b of bulk) console.log(`SCALE|${b.path}|${b.ms}|${b.rows ?? ""}`);
    const budget = Number(process.env.LUME_SCALE_BULK_BUDGET ?? 120_000);
    expect(
      bulk.filter((b) => b.ms > budget),
      `bulk over ${budget} ms`,
    ).toEqual([]);
  }, 3_600_000);

  it("explains the slow paths (query plans, printed)", async () => {
    if (!process.env.LUME_SCALE_EXPLAIN) return;
    const cfg = await h.config();
    const repId = (await h.queryAll<{ id: string }>("SELECT id FROM users WHERE name = 'Person 1'"))[0]!.id;
    const tag = (await h.queryAll<{ id: string }>("SELECT id FROM tags WHERE label = 'Tag 1'"))[0]!.id;
    /** An EXPLAIN statement, run as a person of this scope would run it: row-level security applies (FORCE). */
    const explain = async (
      title: string,
      scope: "all" | "own",
      text: string,
      params: unknown[] = [],
      noSeq = false,
    ) => {
      const c = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true)",
          [repId, scope],
        );
        if (noSeq) await c.query("SET LOCAL enable_seqscan = off");
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
    for (const [title, term] of [
      ["candidates: common name", "%Lina Faris%"],
      ["candidates: rare (no match)", "%Zzyzx%"],
    ] as const)
      await explain(
        title,
        "all",
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL AND (name ILIKE $1
           OR email::text ILIKE $1 OR instagram_handle::text ILIKE $1) LIMIT 10001`,
        [term],
        true,
      );
    for (const [title, where] of [
      ["one column: name", "name ILIKE '%Zzyzx%'"],
      ["one column: email", "email::text ILIKE '%Zzyzx%'"],
      ["one column: instagram", "instagram_handle::text ILIKE '%Zzyzx%'"],
      ["one column: phone", "phone_digits LIKE '%501234%'"],
    ] as const)
      await explain(
        title,
        "all",
        `EXPLAIN (ANALYZE, COSTS OFF) SELECT id FROM leads WHERE ${where} LIMIT 10001`,
        [],
        true,
      );
    await explain(
      "candidates: phone digits",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL AND (name ILIKE '%501234%'
         OR email::text ILIKE '%501234%' OR instagram_handle::text ILIKE '%501234%' OR phone_digits LIKE '%501234%') LIMIT 10001`,
      [],
      true,
    );
    // The capped search, piece by piece: the search itself, then the page read by its 10,001 hits.
    await explain(
      "search function, common term (capped)",
      "all",
      "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT lume_lead_search('%Lina%', NULL, '%Lina%', '%Lina%', NULL, 10001) AS id",
    );
    const hits = (
      await h.queryAll<{ id: string }>(
        "SELECT lead_id AS id FROM lead_search WHERE live AND name ILIKE '%Lina%' ORDER BY lead_id DESC LIMIT 10001",
      )
    ).map((x) => x.id);
    await explain(
      "the page by 10,001 search hits",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL
         AND id = ANY($1::uuid[]) ORDER BY id DESC LIMIT 51`,
      [`{${hits.join(",")}}`],
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
    const tag1 = (await h.queryAll<{ id: string }>("SELECT id FROM tags WHERE label = 'Tag 1'"))[0]!.id;
    await explain(
      "tag counts (the app's query)",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT stage_id, count(*) FROM leads l WHERE deleted_at IS NULL AND pipeline_id = $1
         AND EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag_id = $2) GROUP BY stage_id`,
      [cfg.pipelineId, tag1],
    );
    await explain(
      "tag list, common tag (the app's query)",
      "all",
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads l WHERE deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag_id = $1) ORDER BY id DESC LIMIT 51`,
      [tag1],
    );
    await explain(
      "rep list (own)",
      "own",
      "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM leads WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 51",
    );
  }, 600_000);
});
