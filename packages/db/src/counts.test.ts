import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Phase 7A Task 5 (0048): lead_counts, the stage strip's counts kept by trigger. At 1,000,000 leads counting live
 * took 386 ms (admin) and 363 ms (a team lead). The table must always equal a live count, whatever happens to leads.
 */
const U = [
  "0190e0c0-0000-7000-8000-0000000009a1",
  "0190e0c0-0000-7000-8000-0000000009a2",
  "0190e0c0-0000-7000-8000-0000000009a3",
];
const P = ["0190e0c0-0000-7000-8000-0000000009f1", "0190e0c0-0000-7000-8000-0000000009f2"];
const S: Record<string, string[]> = {
  [P[0]!]: [
    "0190e0c0-0000-7000-8000-0000000009e1",
    "0190e0c0-0000-7000-8000-0000000009e2",
    "0190e0c0-0000-7000-8000-0000000009e3",
  ],
  [P[1]!]: ["0190e0c0-0000-7000-8000-0000000009d1", "0190e0c0-0000-7000-8000-0000000009d2"],
};

let db: TestDatabase;
type Ctx = { scope?: string; user?: string; team?: string };
async function as<T>(role: DbRole, ctx: Ctx, fn: (c: pg.Client) => Promise<T>, commit = true): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    for (const [k, name] of [
      ["scope", "lume.lead_scope"],
      ["user", "lume.user_id"],
      ["team", "lume.team_member_ids"],
    ] as const)
      if (ctx[k] !== undefined) await c.query("SELECT set_config($1, $2, true)", [name, ctx[k]]);
    const out = await fn(c);
    await c.query(commit ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const all: Ctx = { scope: "all", user: U[0] };

/** The table, and a live count, as comparable rows. */
const fromTable = () =>
  as(
    "lume_owner",
    all,
    async (c) =>
      (
        await c.query(
          `SELECT pipeline_id, stage_id, owner_id, n::int AS n, value::text AS value FROM lead_counts_now
          WHERE n <> 0 ORDER BY 1, 2, 3 NULLS FIRST`,
        )
      ).rows,
  );
/** The base table alone (after a rollup it must be exact on its own). */
const baseOnly = () =>
  as(
    "lume_owner",
    all,
    async (c) =>
      (
        await c.query(
          `SELECT pipeline_id, stage_id, owner_id, n::int AS n, value::text AS value FROM lead_counts
          WHERE n <> 0 ORDER BY 1, 2, 3 NULLS FIRST`,
        )
      ).rows,
  );
const rollup = () => as("lume_app", all, (c) => c.query("SELECT lume_lead_counts_rollup()"));
const live = () =>
  as(
    "lume_owner",
    all,
    async (c) =>
      (
        await c.query(
          `SELECT pipeline_id, stage_id, owner_id, count(*)::int AS n, coalesce(sum(value), 0)::numeric(20,2)::text AS value
           FROM leads WHERE deleted_at IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 NULLS FIRST`,
        )
      ).rows,
  );

// A small deterministic random source, so a failing sequence can be replayed.
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as("lume_owner", all, async (c) => {
    for (const [i, id] of U.entries())
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        `u${i}@example.test`,
        `U${i}`,
      ]);
    for (const p of P) {
      await c.query("INSERT INTO pipelines (id, name, is_default) VALUES ($1, $2, $3)", [
        p,
        `P ${p.slice(-2)}`,
        p === P[0],
      ]);
      for (const [i, s] of S[p]!.entries())
        await c.query(
          "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ($1, $2, $3, 'open', $4)",
          [s, p, `S${i}`, i],
        );
    }
  });
});
afterAll(async () => db.drop());

describe("0048: lead_counts always equals a live count", { timeout: 60_000 }, () => {
  it("random sequences of every kind of change (create, move, reassign, value, pipeline, delete, restore, in bulk)", async () => {
    const owners = [...U, null];
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const ids: string[] = [];
      for (let step = 0; step < 40; step++) {
        const op = ids.length < 3 ? 0 : Math.floor(r() * 7);
        const p = pick(r, P);
        await as("lume_owner", all, async (c) => {
          switch (op) {
            case 0: {
              // Several leads in one statement.
              const n = 1 + Math.floor(r() * 4);
              const made = await c.query<{ id: string }>(
                `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, value)
                 SELECT gen_random_uuid(), $1, $2, $3, 'L', $4 FROM generate_series(1, $5) RETURNING id`,
                [
                  p,
                  pick(r, S[p]!),
                  pick(r, owners),
                  r() < 0.5 ? (Math.floor(r() * 10000) / 100).toFixed(2) : null,
                  n,
                ],
              );
              ids.push(...made.rows.map((x) => x.id));
              break;
            }
            case 1: {
              // Move within the lead's own pipeline.
              const id = pick(r, ids);
              await c.query(
                "UPDATE leads SET stage_id = (SELECT s FROM unnest($2::uuid[]) s ORDER BY random() LIMIT 1) WHERE id = $1",
                [
                  id,
                  S[
                    (await c.query("SELECT pipeline_id FROM leads WHERE id = $1", [id])).rows[0].pipeline_id
                  ]!,
                ],
              );
              break;
            }
            case 2:
              await c.query("UPDATE leads SET owner_id = $2 WHERE id = $1", [pick(r, ids), pick(r, owners)]);
              break;
            case 3:
              await c.query("UPDATE leads SET value = $2 WHERE id = $1", [
                pick(r, ids),
                r() < 0.3 ? null : (r() * 1000).toFixed(2),
              ]);
              break;
            case 4:
              await c.query("UPDATE leads SET pipeline_id = $2, stage_id = $3 WHERE id = $1", [
                pick(r, ids),
                p,
                pick(r, S[p]!),
              ]);
              break;
            case 5:
              await c.query(
                "UPDATE leads SET deleted_at = CASE WHEN deleted_at IS NULL THEN now() ELSE NULL END WHERE id = $1",
                [pick(r, ids)],
              );
              break;
            case 6:
              // Many leads in one statement: everything of one owner to another, and a touch that changes nothing counted.
              await c.query("UPDATE leads SET owner_id = $2 WHERE owner_id IS NOT DISTINCT FROM $1", [
                pick(r, owners),
                pick(r, owners),
              ]);
              await c.query("UPDATE leads SET last_activity_at = now() WHERE id = ANY($1)", [
                ids.slice(0, 5),
              ]);
              break;
          }
        });
        // LUME's minute rollup, now and then, mid-sequence.
        if (r() < 0.15) await rollup();
      }
      expect(await fromTable(), `seed ${seed}`).toEqual(await live());
      // Rolled up, the deltas are gone and the base alone is exact.
      await rollup();
      const left = await as(
        "lume_owner",
        all,
        async (c) => (await c.query("SELECT count(*)::int AS n FROM lead_count_deltas")).rows[0].n,
      );
      expect(left).toBe(0);
      expect(await baseOnly(), `seed ${seed} base`).toEqual(await live());
    }
  }, 120_000);

  it("two people creating leads in the same stage at once never wait on each other, and both count (7A review)", async () => {
    const [p, s] = [P[1]!, S[P[1]!]![1]!];
    const before = await fromTable();
    const one = new pg.Client({ connectionString: db.url("lume_app") });
    const two = new pg.Client({ connectionString: db.url("lume_app") });
    await one.connect();
    await two.connect();
    try {
      for (const c of [one, two]) {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.lead_scope', 'own', true), set_config('lume.user_id', $1, true)",
          [U[1]],
        );
      }
      const ins = (c: pg.Client) =>
        c.query(
          "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), $1, $2, $3, 'C')",
          [p, s, U[1]],
        );
      await ins(one);
      // The second must not wait for the first: a lock wait would hit this timeout.
      await two.query("SET LOCAL lock_timeout = '1s'");
      await ins(two);
      await one.query("COMMIT");
      await two.query("COMMIT");
    } finally {
      await one.end();
      await two.end();
    }
    expect(await fromTable()).toEqual(await live());
    expect(await fromTable()).not.toEqual(before);
  });

  it("a rollup while a change is still uncommitted loses nothing and counts nothing twice", async () => {
    const [p, s] = [P[0]!, S[P[0]!]![0]!];
    const open = new pg.Client({ connectionString: db.url("lume_app") });
    await open.connect();
    try {
      await open.query("BEGIN");
      await open.query(
        "SELECT set_config('lume.lead_scope', 'own', true), set_config('lume.user_id', $1, true)",
        [U[2]],
      );
      await open.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, value) VALUES (gen_random_uuid(), $1, $2, $3, 'R', 12.5)",
        [p, s, U[2]],
      );
      await rollup();
      await open.query("COMMIT");
    } finally {
      await open.end();
    }
    expect(await fromTable()).toEqual(await live());
    await rollup();
    expect(await fromTable()).toEqual(await live());
    expect(await baseOnly()).toEqual(await live());
  });

  it("backups read the counts with an empty search_path, as pg_dump does (7A: the helper must not need one)", async () => {
    const c = new pg.Client({ connectionString: db.url("lume_readonly_backup") });
    await c.connect();
    try {
      await c.query("SET search_path = ''");
      await c.query("SET row_security = on");
      await c.query("SELECT count(*) FROM public.lead_counts");
      await c.query("SELECT count(*) FROM public.lead_count_deltas");
      await c.query("SELECT count(*) FROM public.lead_counts_now");
      await c.query("SELECT count(*) FROM public.lead_search");
    } finally {
      await c.end();
    }
  });

  it("the app reads only the counts its scope may see, and can't write them", async () => {
    const rows = (ctx: Ctx) =>
      as("lume_app", ctx, async (c) =>
        (
          await c.query("SELECT DISTINCT owner_id FROM lead_counts_now WHERE n <> 0 ORDER BY 1 NULLS FIRST")
        ).rows.map((x) => x.owner_id),
      );
    // An unassigned lead of its own (the random sequences may have handed every unassigned one out).
    await as("lume_owner", all, (c) =>
      c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), $1, $2, NULL, 'U')",
        [P[0], S[P[0]!]![0]],
      ),
    );
    const everyone = await rows({ scope: "all", user: U[0] });
    expect(everyone).toContain(null); // unassigned: 'all' only
    expect(await rows({ scope: "own", user: U[0] })).toEqual(everyone.filter((o) => o === U[0]));
    expect(await rows({ scope: "team", user: U[0], team: `{${U[1]}}` })).toEqual(
      everyone.filter((o) => o === U[0] || o === U[1]),
    );
    expect(await rows({})).toEqual([]);
    await expect(as("lume_app", all, (c) => c.query("UPDATE lead_counts SET n = 0"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as("lume_app", all, (c) => c.query("DELETE FROM lead_counts"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as("lume_app", all, (c) =>
        c.query("INSERT INTO lead_count_deltas (pipeline_id, stage_id, n, value) VALUES ($1, $2, 5, 0)", [
          P[0],
          S[P[0]!]![0],
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
