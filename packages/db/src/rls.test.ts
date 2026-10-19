import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { contactKeyHash } from "./contact-keys";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Report §7.4 / §17 Phase 1 acceptance: row-level security alone — raw SQL as lume_app, no service
 * code — refuses out-of-scope leads and everything hanging off them.
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000000a",
  mate: "0190e0c0-0000-7000-8000-00000000000b",
  other: "0190e0c0-0000-7000-8000-00000000000c",
};
const L = {
  rep: "0190e0c0-0000-7000-8000-0000000000a1",
  mate: "0190e0c0-0000-7000-8000-0000000000b1",
  other: "0190e0c0-0000-7000-8000-0000000000c1",
  none: "0190e0c0-0000-7000-8000-0000000000d1",
};

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as("lume_owner", { scope: "all", user: U.rep }, async (c) => {
    for (const [id, email] of [
      [U.rep, "rep@x.com"],
      [U.mate, "mate@x.com"],
      [U.other, "other@x.com"],
    ]) {
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        email,
        email,
      ]);
    }
    await c.query(
      "INSERT INTO pipelines (id, name, is_default) VALUES ('0190e0c0-0000-7000-8000-0000000000f1', 'P', true)",
    );
    await c.query(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ('0190e0c0-0000-7000-8000-0000000000f2', '0190e0c0-0000-7000-8000-0000000000f1', 'New', 'open', 0)",
    );
    for (const [id, owner] of [
      [L.rep, U.rep],
      [L.mate, U.mate],
      [L.other, U.other],
      [L.none, null],
    ] as const) {
      await c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_e164, phone_status, email) VALUES ($1, '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $2, $5, $3, 'valid', $4)",
        [id, owner, id === L.other ? "+971501234567" : null, `${id}@leads.test`, `Lead ${id.slice(-2)}`],
      );
      await c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [
        id,
      ]);
    }
  });
});
afterAll(async () => db.drop());

type Scope = { scope: "own" | "team" | "all" | null; user?: string; team?: string[] };
async function as<T>(role: DbRole, s: Scope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (s.scope) {
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', $3, true)",
        [s.user ?? U.rep, s.scope, `{${(s.team ?? []).join(",")}}`],
      );
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const ids = async (role: DbRole, s: Scope, sql: string) =>
  (await as(role, s, async (c) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id))).sort();

describe("RLS on leads, by raw SQL as lume_app", () => {
  it("own scope sees only my leads; team adds my team's; all sees everything incl. unassigned", async () => {
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([L.rep]);
    expect(await ids("lume_app", { scope: "team", team: [U.rep, U.mate] }, "SELECT id FROM leads")).toEqual(
      [L.rep, L.mate].sort(),
    );
    expect(await ids("lume_app", { scope: "all" }, "SELECT id FROM leads")).toEqual(Object.values(L).sort());
  });

  it("fails closed: no request scope, no rows — even for the table owner", async () => {
    expect(await ids("lume_app", { scope: null }, "SELECT id FROM leads")).toEqual([]);
    expect(await ids("lume_owner", { scope: null }, "SELECT id FROM leads")).toEqual([]);
  });

  it("child tables inherit the lead's visibility", async () => {
    const rows = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("SELECT lead_id FROM activities")).rows,
    );
    expect(rows).toEqual([{ lead_id: L.rep }]);
  });

  it("a rep cannot create a lead for someone else, or hang an activity off one they can't see", async () => {
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query(
          "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $1, 'x')",
          [U.other],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [
          L.other,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("updates reach only visible leads, but may hand a lead away; deletes and history rewrites do nothing", async () => {
    const touched = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("UPDATE leads SET name = 'hacked' WHERE id = $1", [L.other])).rowCount,
    );
    expect(touched).toBe(0);
    // Without the handoff allowance the new row fails the read policy (Postgres checks it for UPDATE ... WHERE).
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, L.rep]),
      ),
    ).rejects.toThrow(/row-level security/);
    // A handoff can't be used to take someone else's lead: the existing row must already be visible.
    const stolen = await as("lume_app", { scope: "own" }, async (c) => {
      await c.query("SELECT set_config('lume.handoff_lead', $1, true)", [L.other]);
      return (await c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, L.other])).rowCount;
    });
    expect(stolen).toBe(0);
    await as("lume_app", { scope: "own" }, async (c) => {
      await c.query("SELECT set_config('lume.handoff_lead', $1, true)", [L.rep]);
      await c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, L.rep]);
    });
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([]); // gone from my view at once
    const deleted = await as(
      "lume_app",
      { scope: "all" },
      async (c) => (await c.query("DELETE FROM leads")).rowCount,
    );
    expect(deleted).toBe(0);
    await expect(
      as("lume_app", { scope: "all" }, (c) => c.query("UPDATE activities SET type = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, L.rep]),
    );
  });

  it("7A: the read policy evaluates its settings once per query, never a function per row", async () => {
    for (const s of [
      { scope: "own" as const },
      { scope: "team" as const, team: [U.mate] },
      { scope: "all" as const },
    ]) {
      const plan = await as("lume_app", s, async (c) =>
        JSON.stringify(
          (await c.query("EXPLAIN (FORMAT JSON) SELECT id FROM leads WHERE deleted_at IS NULL")).rows[0],
        ),
      );
      expect(plan).not.toContain("lume_can_see_owner");
      expect(plan).toContain("InitPlan");
    }
  });

  it("7A: the policies mean exactly what lume_can_see_owner meant, in every context (Review Focus 1)", async () => {
    // Each context as raw settings; null leaves a setting unset. The oracle is the old rule itself, evaluated over
    // every row by the backup role (which reads every row), with the same settings.
    type Ctx = { scope?: string; user?: string; team?: string; handoff?: string };
    const contexts: Ctx[] = [
      {},
      { scope: "all" },
      { scope: "all", user: "" },
      { scope: "own", user: U.rep },
      { scope: "own", user: "" },
      { scope: "own", user: U.other },
      { scope: "team", user: U.rep },
      { scope: "team", user: U.rep, team: "{}" },
      { scope: "team", user: U.rep, team: `{${U.mate}}` },
      { scope: "team", user: "", team: `{${U.mate}}` },
      { scope: "team", user: U.rep, team: `{${U.rep},${U.mate},${U.other}}` },
      { scope: "bogus", user: U.rep },
      { scope: "", user: U.rep },
      { scope: "own", user: U.rep, handoff: L.other },
      { handoff: L.mate },
      { scope: "all", handoff: L.none },
      { scope: "team", user: U.rep, team: `{${U.mate}}`, handoff: L.none },
    ];
    const run = async <T>(role: DbRole, ctx: Ctx, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
      const c = new pg.Client({ connectionString: db.url(role) });
      await c.connect();
      try {
        await c.query("BEGIN");
        for (const [k, name] of [
          ["scope", "lume.lead_scope"],
          ["user", "lume.user_id"],
          ["team", "lume.team_member_ids"],
          ["handoff", "lume.handoff_lead"],
        ] as const)
          if (ctx[k] !== undefined) await c.query("SELECT set_config($1, $2, true)", [name, ctx[k]]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    };
    const owners = [U.rep, U.mate, U.other, null];
    // Every lead tagged, so lead_tags' read policy is compared too.
    await as("lume_owner", { scope: "all" }, async (c) => {
      await c.query(
        "INSERT INTO tags (id, label) VALUES ('0190e0c0-0000-7000-8000-0000000000e9', 'Eq') ON CONFLICT DO NOTHING",
      );
      await c.query(
        "INSERT INTO lead_tags (lead_id, tag_id) SELECT id, '0190e0c0-0000-7000-8000-0000000000e9' FROM leads ON CONFLICT DO NOTHING",
      );
    });
    for (const ctx of contexts) {
      const label = JSON.stringify(ctx);
      // Read: what the policy shows equals the old rule over every row.
      const seen = await run("lume_app", ctx, async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM leads ORDER BY id")).rows.map((r) => r.id),
      );
      const oracle = await run("lume_readonly_backup", ctx, async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM leads WHERE lume_can_see_owner(owner_id) OR id = lume_handoff_lead() ORDER BY id",
          )
        ).rows.map((r) => r.id),
      );
      expect(seen, `read ${label}`).toEqual(oracle);
      // lead_tags: a lead's tags are seen exactly when the lead is.
      const tagsSeen = await run("lume_app", ctx, async (c) =>
        (await c.query<{ lead_id: string }>("SELECT lead_id FROM lead_tags ORDER BY lead_id")).rows.map(
          (r) => r.lead_id,
        ),
      );
      const tagsOracle = await run("lume_readonly_backup", ctx, async (c) =>
        (
          await c.query<{ lead_id: string }>(
            `SELECT t.lead_id FROM lead_tags t JOIN leads l ON l.id = t.lead_id
              WHERE lume_can_see_owner(l.owner_id) OR l.id = lume_handoff_lead() ORDER BY t.lead_id`,
          )
        ).rows.map((r) => r.lead_id),
      );
      expect(tagsSeen, `lead_tags ${label}`).toEqual(tagsOracle);
      // Create: allowed for exactly the owners the old rule allowed.
      for (const owner of owners) {
        const allowed = await run("lume_readonly_backup", ctx, async (c) =>
          Boolean((await c.query("SELECT lume_can_see_owner($1::uuid) AS ok", [owner])).rows[0].ok),
        );
        const created = await run("lume_app", ctx, async (c) => {
          try {
            await c.query(
              "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $1, 'x')",
              [owner],
            );
            return true;
          } catch (e) {
            if (!/row-level security/.test(String(e))) throw e;
            return false;
          }
        });
        expect(created, `create owner=${owner} ${label}`).toBe(allowed);
      }
      // Update: reaches exactly the rows the old rule could see (the hand-off is a read allowance only), and only
      // with a user set.
      for (const lead of Object.values(L)) {
        const reach = await run("lume_readonly_backup", ctx, async (c) =>
          Boolean(
            (
              await c.query(
                "SELECT lume_can_see_owner(owner_id) AND lume_user() IS NOT NULL AS ok FROM leads WHERE id = $1",
                [lead],
              )
            ).rows[0].ok,
          ),
        );
        const updated = await run("lume_app", ctx, async (c) => {
          try {
            return (await c.query("UPDATE leads SET name = name WHERE id = $1", [lead])).rowCount === 1;
          } catch (e) {
            if (!/row-level security/.test(String(e))) throw e;
            return false;
          }
        });
        expect(updated, `update ${lead} ${label}`).toBe(reach);
      }
    }
  }, 60_000);

  it("the backup role reads every row (pg_dump --enable-row-security)", async () => {
    expect(await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM leads")).toEqual(
      Object.values(L).sort(),
    );
  });
});

describe("contact keys (cross-scope duplicate detection without exposing contacts)", () => {
  it("hold only hashes, stay in sync, and are readable regardless of scope", async () => {
    const rows = await as(
      "lume_app",
      { scope: "own" },
      async (c) =>
        (await c.query("SELECT lead_id, kind, key_hash FROM lead_contact_keys WHERE kind = 'phone'")).rows,
    );
    expect(rows).toEqual([
      { lead_id: L.other, kind: "phone", key_hash: contactKeyHash("phone", "+971501234567") },
    ]);
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE leads SET deleted_at = now() WHERE id = $1", [L.other]),
    );
    const after = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("SELECT 1 FROM lead_contact_keys WHERE lead_id = $1", [L.other])).rowCount,
    );
    expect(after).toBe(0); // deleted leads no longer count as duplicates
  });
});

describe("0021_follow_ups: follow-ups are seen with their lead; notifications only by whom they're for", () => {
  const T = { rep: "0190e0c0-0000-7000-8000-0000000001a1", mate: "0190e0c0-0000-7000-8000-0000000001b1" };
  const task = (id: string, lead: string, assignee: string) =>
    as("lume_owner", { scope: "all" }, (c) =>
      c.query(
        "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Follow up', now() + interval '1 hour', $1)",
        [id, lead, assignee],
      ),
    );
  beforeAll(async () => {
    await task(T.rep, L.rep, U.rep);
    await task(T.mate, L.mate, U.mate);
    // FORCE row-level security binds the table's owner too: each is written as its recipient.
    for (const [user, title] of [
      [U.rep, "For rep"],
      [U.mate, "For mate"],
    ])
      await as("lume_owner", { scope: "all", user }, (c) =>
        c.query("INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'follow_up_due', $2)", [
          user,
          title,
        ]),
      );
  });

  it("a rep sees the follow-ups on their own leads only; team and all widen it as leads do", async () => {
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM tasks")).toEqual([T.rep]);
    expect(await ids("lume_app", { scope: "team", team: [U.rep, U.mate] }, "SELECT id FROM tasks")).toEqual(
      [T.rep, T.mate].sort(),
    );
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query(
          "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES (gen_random_uuid(), $1, $2, 'x', now(), gen_random_uuid())",
          [L.mate, U.rep],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      (
        await as("lume_app", { scope: "own" }, (c) =>
          c.query("UPDATE tasks SET title = 'Moved' WHERE id = $1", [T.mate]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it("notifications are only ever their recipient's, even with scope all", async () => {
    const titles = (s: Scope) =>
      as("lume_app", s, async (c) =>
        (await c.query<{ title: string }>("SELECT title FROM notifications")).rows.map((r) => r.title),
      );
    expect(await titles({ scope: "own" })).toEqual(["For rep"]);
    expect(await titles({ scope: "all", user: U.mate })).toEqual(["For mate"]);
    await expect(
      as("lume_app", { scope: "all" }, (c) =>
        c.query("INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'follow_up_due', 'Sneaky')", [
          U.mate,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("each reminder is kept once, and the lists are enforced", async () => {
    const add = () =>
      as("lume_owner", { scope: "all" }, (c) =>
        c.query(
          "INSERT INTO scheduled_notifications (task_id, offset_minutes, fire_at) VALUES ($1, 15, now())",
          [T.rep],
        ),
      );
    await add();
    await expect(add()).rejects.toThrow(/sn_once/);
    await expect(
      as("lume_owner", { scope: "all" }, (c) =>
        c.query("UPDATE tasks SET status = 'nope' WHERE id = $1", [T.rep]),
      ),
    ).rejects.toThrow(/tasks_status/);
  });

  it("the worker may sweep old notifications and read nothing in them", async () => {
    await as("lume_worker", { scope: null }, (c) =>
      c.query("SELECT id, read_at, created_at FROM notifications"),
    );
    await as("lume_worker", { scope: null }, (c) => c.query("DELETE FROM notifications WHERE false"));
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT title FROM notifications")),
    ).rejects.toThrow(/permission/);
  });
});

describe("3A final review, Critical 2: backups", () => {
  it("the backup role reads every follow-up and every notification (pg_dump --enable-row-security)", async () => {
    const tasks = await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM tasks");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const n = await as(
      "lume_readonly_backup",
      { scope: null },
      async (c) => (await c.query("SELECT id FROM notifications")).rowCount,
    );
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("0027_saved_views (4B): a view is its owner's, or shared by role; managers see every shared one", () => {
  const R = { sales: "0190e0c0-0000-7000-8000-0000000000e1", admin: "0190e0c0-0000-7000-8000-0000000000e2" };
  const V = {
    repPersonal: "0190e0c0-0000-7000-8000-0000000000c7",
    mateShared: "0190e0c0-0000-7000-8000-0000000000c8",
    otherPersonal: "0190e0c0-0000-7000-8000-0000000000c9",
    adminOnly: "0190e0c0-0000-7000-8000-0000000000ca",
  };
  type Who = { user: string; roles: string[]; manage?: boolean };
  async function asV<T>(role: DbRole, w: Who, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: db.url(role) });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'own', true),
                set_config('lume.team_member_ids', '{}', true), set_config('lume.role_ids', $2, true),
                set_config('lume.manage_views', $3, true)`,
        [w.user, `{${w.roles.join(",")}}`, w.manage ? "on" : "off"],
      );
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      await c.end();
    }
  }
  const seen = (w: Who) =>
    asV("lume_app", w, async (c) =>
      (await c.query("SELECT id FROM saved_views ORDER BY id")).rows.map((r) => r.id),
    );

  beforeAll(async () => {
    for (const [id, owner, shared] of [
      [V.repPersonal, U.rep, []],
      [V.mateShared, U.mate, [R.sales]],
      [V.otherPersonal, U.other, []],
      [V.adminOnly, U.other, [R.admin]],
    ] as const)
      await asV("lume_app", { user: owner, roles: [] }, (c) =>
        c.query(
          "INSERT INTO saved_views (id, name, color, filters, owner_id, shared_role_ids) VALUES ($1, $2, 'accent', '{}', $3, $4)",
          [id, `View ${id.slice(-2)}`, owner, shared],
        ),
      );
  });

  it("a rep reads their own and those shared with their role, never someone else's personal one", async () => {
    expect(await seen({ user: U.rep, roles: [R.sales] })).toEqual([V.repPersonal, V.mateShared]);
    expect(await seen({ user: U.rep, roles: [] })).toEqual([V.repPersonal]);
  });

  it("a manager reads every shared view, and still not others' personal ones", async () => {
    expect(await seen({ user: U.rep, roles: [], manage: true })).toEqual([
      V.repPersonal,
      V.mateShared,
      V.adminOnly,
    ]);
  });

  it("a rep can't change or delete a shared view they don't own; a manager can", async () => {
    const renamed = await asV("lume_app", { user: U.rep, roles: [R.sales] }, (c) =>
      c.query("UPDATE saved_views SET name = 'Mine now' WHERE id = $1", [V.mateShared]),
    );
    expect(renamed.rowCount).toBe(0);
    const gone = await asV("lume_app", { user: U.rep, roles: [R.sales] }, (c) =>
      c.query("DELETE FROM saved_views WHERE id = $1", [V.mateShared]),
    );
    expect(gone.rowCount).toBe(0);
    const managed = await asV("lume_app", { user: U.rep, roles: [], manage: true }, (c) =>
      c.query("UPDATE saved_views SET color = 'ok' WHERE id = $1", [V.mateShared]),
    );
    expect(managed.rowCount).toBe(1);
  });

  it("nobody creates a view in someone else's name", async () => {
    await expect(
      asV("lume_app", { user: U.rep, roles: [] }, (c) =>
        c.query(
          "INSERT INTO saved_views (id, name, color, filters, owner_id) VALUES (gen_random_uuid(), 'Sneaky', 'accent', '{}', $1)",
          [U.other],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the backup role reads every view; the worker none", async () => {
    const all = await as(
      "lume_readonly_backup",
      { scope: null },
      async (c) => (await c.query("SELECT id FROM saved_views")).rowCount,
    );
    expect(all).toBe(4);
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT id FROM saved_views")),
    ).rejects.toThrow(/permission/);
  });

  it("leads changing says so on lume_leads, once for a many-row change in one transaction", async () => {
    const listener = new pg.Client({ connectionString: db.url("lume_owner") });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (m) => heard.push(m.channel));
    await listener.query("LISTEN lume_leads");
    try {
      await as("lume_owner", { scope: "all", user: U.rep }, async (c) => {
        await c.query("UPDATE leads SET name = name || '' WHERE id = ANY($1)", [[L.rep, L.mate, L.other]]);
        await c.query("UPDATE leads SET name = name || '' WHERE id = $1", [L.none]);
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(heard).toEqual(["lume_leads"]);
    } finally {
      await listener.end();
    }
  });
});

describe("0029_send_queue (4C): a run and its items are only their person's", () => {
  const Q = { rep: "0190e0c0-0000-7000-8000-0000000000d7", mate: "0190e0c0-0000-7000-8000-0000000000d8" };
  const asUser = <T>(user: string, fn: (c: pg.Client) => Promise<T>) =>
    as("lume_app", { scope: "all", user }, fn);

  beforeAll(async () => {
    for (const [id, user, lead] of [
      [Q.rep, U.rep, L.rep],
      [Q.mate, U.mate, L.mate],
    ] as const)
      await asUser(user, async (c) => {
        await c.query(
          "INSERT INTO send_queues (id, user_id, source, source_name) VALUES ($1, $2, 'selection', 'Your selection')",
          [id, user],
        );
        await c.query("INSERT INTO send_queue_items (queue_id, position, lead_id) VALUES ($1, 0, $2)", [
          id,
          lead,
        ]);
      });
  });

  it("each person reads only their own runs and items, even seeing every lead", async () => {
    const mine = await asUser(U.rep, async (c) => ({
      queues: (await c.query("SELECT id FROM send_queues")).rows.map((r) => r.id),
      items: (await c.query("SELECT queue_id FROM send_queue_items")).rows.map((r) => r.queue_id),
    }));
    expect(mine).toEqual({ queues: [Q.rep], items: [Q.rep] });
  });

  it("nobody starts a run in someone else's name, or adds to one", async () => {
    await expect(
      asUser(U.rep, (c) =>
        c.query(
          "INSERT INTO send_queues (id, user_id, source, source_name) VALUES (gen_random_uuid(), $1, 'selection', 'x')",
          [U.mate],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(U.rep, (c) =>
        c.query("INSERT INTO send_queue_items (queue_id, position, lead_id) VALUES ($1, 1, $2)", [
          Q.mate,
          L.rep,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("one open run per person", async () => {
    await expect(
      asUser(U.rep, (c) =>
        c.query(
          "INSERT INTO send_queues (id, user_id, source, source_name) VALUES (gen_random_uuid(), $1, 'selection', 'Again')",
          [U.rep],
        ),
      ),
    ).rejects.toThrow(/send_queues_one_open/);
  });

  it("the backup role reads every run; the worker none", async () => {
    const n = await as(
      "lume_readonly_backup",
      { scope: null },
      async (c) => (await c.query("SELECT queue_id FROM send_queue_items")).rowCount,
    );
    expect(n).toBe(2);
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT id FROM send_queues")),
    ).rejects.toThrow(/permission/);
  });
});

describe("LUME AI's reads (spec 2026-10-18 §2.3)", () => {
  const read = (lead: string, at = "now()") =>
    `INSERT INTO ai_reads (id, lead_id, user_id, task, provider, model, input_tokens, output_tokens, status, created_at)
     VALUES (gen_random_uuid(), '${lead}', '${U.rep}', 'next_step', 'fake', 'fake-1', 10, 5, 'ok', ${at})`;
  beforeAll(async () => {
    await as("lume_owner", { scope: "all" }, async (c) => {
      for (const lead of [L.rep, L.other]) await c.query(read(lead));
      await c.query(read(L.other, "now() - interval '2 hours'"));
      await c.query(
        `INSERT INTO ai_reads (id, lead_id, user_id, task, provider, model, input_tokens, output_tokens, status)
         VALUES (gen_random_uuid(), '${L.rep}', '${U.rep}', 'next_step', 'fake', 'fake-1', 10, 0, 'failed')`,
      );
    });
  });

  it("each read is seen only with its lead", async () => {
    const leads = await as("lume_app", { scope: "own" }, async (c) =>
      (await c.query<{ lead_id: string }>("SELECT DISTINCT lead_id FROM ai_reads")).rows.map(
        (r) => r.lead_id,
      ),
    );
    expect(leads).toEqual([L.rep]);
    await expect(as("lume_app", { scope: "own" }, (c) => c.query(read(L.other)))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("only its outcome can change, and no read is ever deleted by the app", async () => {
    await as("lume_app", { scope: "own" }, (c) =>
      c.query(
        `UPDATE ai_reads SET outcome = 'dismissed', outcome_by = '${U.rep}', outcome_at = now() WHERE lead_id = '${L.rep}'`,
      ),
    );
    await expect(
      as("lume_app", { scope: "own" }, (c) => c.query("UPDATE ai_reads SET result = '{}'::jsonb")),
    ).rejects.toThrow(/permission/);
    await expect(as("lume_app", { scope: "all" }, (c) => c.query("DELETE FROM ai_reads"))).rejects.toThrow(
      /permission/,
    );
  });

  it("the business's use counts every good read, whoever asks, and says the oldest in the hour", async () => {
    const usage = await as(
      "lume_app",
      { scope: "own" },
      async (c) =>
        (
          await c.query<{ hour_n: number; hour_oldest: Date | null; week_n: number }>(
            "SELECT * FROM lume_ai_usage(now() - interval '1 hour', now() - interval '7 days')",
          )
        ).rows[0]!,
    );
    expect(usage.hour_n).toBe(2); // one on the rep's lead, one on a lead the rep can't see; the failed read isn't counted
    expect(usage.week_n).toBe(3);
    expect(usage.hour_oldest).toBeInstanceOf(Date);
  });

  it("the backup role reads every read", async () => {
    expect(
      await as("lume_readonly_backup", { scope: null }, async (c) =>
        Number((await c.query("SELECT count(*) FROM ai_reads")).rows[0].count),
      ),
    ).toBe(4);
  });
});

describe("LUME AI's use count leaves the request's own scope as it was", () => {
  it("a rep's next query in the same transaction still sees only their leads", async () => {
    const seen = await as("lume_app", { scope: "own" }, async (c) => {
      await c.query("SELECT * FROM lume_ai_usage(now() - interval '1 hour', now() - interval '7 days')");
      return (await c.query<{ id: string }>("SELECT id FROM leads")).rows.map((r) => r.id);
    });
    expect(seen).toEqual([L.rep]);
  });
});

describe("LUME AI's slots: reserved under one lock, then finished (spec 2026-10-18 §2.2)", () => {
  const reserve = (c: pg.Client, now: string, hourLimit: number | null, weekLimit: number | null) =>
    c
      .query<{ id: string | null; refused: string | null; hour_oldest: Date | null }>(
        `SELECT * FROM lume_ai_reserve($1, $2, 'next_step', NULL, 'fake', 'fake-1', $3::timestamptz, $4, $5,
                                       $3::timestamptz - interval '1 hour', $3::timestamptz - interval '7 days')`,
        [L.rep, U.rep, now, hourLimit, weekLimit],
      )
      .then((r) => r.rows[0]!);
  const NOW = "2030-01-07T10:00:00Z"; // well after every other read in this file

  it("reserves a slot while there's room, and refuses the one past the hourly limit with when it frees up", async () => {
    const first = await as("lume_app", { scope: "own" }, (c) => reserve(c, NOW, 1, null));
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    const second = await as("lume_app", { scope: "own" }, (c) => reserve(c, NOW, 1, null));
    expect(second).toMatchObject({ id: null, refused: "hour" });
    expect(second.hour_oldest!.toISOString()).toBe("2030-01-07T10:00:00.000Z");
  });

  it("a slot that was never finished stops counting after two minutes", async () => {
    const later = "2030-01-07T10:03:00Z";
    expect((await as("lume_app", { scope: "own" }, (c) => reserve(c, later, 1, null))).id).not.toBeNull();
  });

  it("two reserves at the last slot at once: only one gets it", async () => {
    const at = "2030-02-04T10:00:00Z";
    const [a, b] = await Promise.all([
      as("lume_app", { scope: "own" }, (c) => reserve(c, at, 1, null)),
      as("lume_app", { scope: "own" }, (c) => reserve(c, at, 1, null)),
    ]);
    expect([a.id, b.id].filter(Boolean)).toHaveLength(1);
  });

  it("finishing a slot sets its status, result and tokens once; the app still can't edit them itself", async () => {
    const at = "2030-03-04T10:00:00Z";
    const { id } = await as("lume_app", { scope: "own" }, (c) => reserve(c, at, null, null));
    await as("lume_app", { scope: "own" }, (c) =>
      c.query("SELECT lume_ai_finish($1, 'ok', '{\"summary\":\"x\"}'::jsonb, 120, 30)", [id]),
    );
    await as("lume_app", { scope: "own" }, (c) =>
      c.query("SELECT lume_ai_finish($1, 'failed', NULL, 0, 0)", [id]),
    );
    const row = await as(
      "lume_app",
      { scope: "own" },
      async (c) =>
        (await c.query("SELECT status, result, input_tokens FROM ai_reads WHERE id = $1", [id])).rows[0],
    );
    expect(row).toEqual({ status: "ok", result: { summary: "x" }, input_tokens: 120 });
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("UPDATE ai_reads SET status = 'ok' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/permission/);
  });
});

describe("WhatsApp (spec 2026-10-18 §4.1, §6.3; plan W1 Task 3)", () => {
  const N = { rep: "0190e0c0-0000-7000-8000-0000000000e1", biz: "0190e0c0-0000-7000-8000-0000000000e2" };
  beforeAll(async () => {
    await as("lume_owner", { scope: "all", user: U.rep }, async (c) => {
      for (const [id, owner, pnid] of [
        [N.rep, U.rep, "1111111111"],
        [N.biz, null, "2222222222"],
      ] as const)
        await c.query(
          `INSERT INTO whatsapp_numbers (id, phone_number_id, waba_id, display_phone, owner_user_id, run_as, status, token_enc)
           VALUES ($1, $2, '99999', '+91 90000 00001', $3, $4, 'active', decode('00', 'hex'))`,
          [id, pnid, owner, U.rep],
        );
      for (const [n, peer, wamid] of [
        [N.rep, "+919000000011", "wamid.R1"],
        [N.biz, "+919000000022", "wamid.B1"],
      ] as const)
        await c.query(
          "INSERT INTO whatsapp_inbox (id, number_id, peer, wamid, at, text) VALUES (gen_random_uuid(), $1, $2, $3, now(), 'hi')",
          [n, peer, wamid],
        );
      for (const lead of [L.rep, L.other])
        await c.query(
          "INSERT INTO whatsapp_media (id, number_id, meta_id, lead_id, kind, mime, status) VALUES (gen_random_uuid(), $1, $2, $3, 'image', 'image/jpeg', 'waiting')",
          [N.rep, `m-${lead.slice(-2)}`, lead],
        );
    });
  });

  it("Not a lead yet: a rep sees their own number's strangers only; someone who sees every lead sees all", async () => {
    const peers = (s: Scope) =>
      as("lume_app", s, async (c) =>
        (await c.query<{ peer: string }>("SELECT peer FROM whatsapp_inbox ORDER BY peer")).rows.map(
          (r) => r.peer,
        ),
      );
    expect(await peers({ scope: "own", user: U.rep })).toEqual(["+919000000011"]);
    expect(await peers({ scope: "own", user: U.mate })).toEqual([]);
    expect(await peers({ scope: "all", user: U.mate })).toEqual(["+919000000011", "+919000000022"]);
    // Nothing at all without a person on the request.
    expect(await peers({ scope: null })).toEqual([]);
  });

  it("a rep can't clear another number's strangers", async () => {
    await as("lume_app", { scope: "own", user: U.mate }, (c) => c.query("DELETE FROM whatsapp_inbox"));
    expect(
      await as("lume_owner", { scope: "all" }, async (c) =>
        Number((await c.query("SELECT count(*) FROM whatsapp_inbox")).rows[0].count),
      ),
    ).toBe(2);
  });

  it("a photo on a lead is seen with its lead; purging the lead purges its media", async () => {
    const seen = (s: Scope) =>
      as("lume_app", s, async (c) =>
        (await c.query<{ meta_id: string }>("SELECT meta_id FROM whatsapp_media ORDER BY meta_id")).rows.map(
          (r) => r.meta_id,
        ),
      );
    expect(await seen({ scope: "own", user: U.rep })).toEqual([`m-${L.rep.slice(-2)}`]);
    expect(await seen({ scope: "all" })).toHaveLength(2);
    // Leads are soft-deleted (no DELETE policy); a purge that removes one takes its media with it.
    const cascade = await as("lume_owner", { scope: "all" }, async (c) =>
      (
        await c.query<{ t: string }>(
          "SELECT confdeltype AS t FROM pg_constraint WHERE conrelid = 'whatsapp_media'::regclass AND confrelid = 'leads'::regclass",
        )
      ).rows.map((r) => r.t),
    );
    expect(cascade).toEqual(["c"]);
  });

  it("a file's count of media follows every insert, change and cascade, whoever's rows are hidden (migration 0074)", async () => {
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const refs = () =>
      as("lume_app", { scope: null }, async (c) =>
        Object.fromEntries(
          (
            await c.query<{ sha256: string; refs: number }>("SELECT sha256, refs FROM whatsapp_files")
          ).rows.map((r) => [r.sha256.slice(0, 1), r.refs]),
        ),
      );
    // The API writes the file row first, then points media at it, as the rep (row-level security on).
    await as("lume_app", { scope: "own", user: U.rep }, async (c) => {
      await c.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 10), ($2, 20)", [A, B]);
      await c.query("UPDATE whatsapp_media SET status = 'ready', sha256 = $1 WHERE lead_id = $2", [A, L.rep]);
    });
    // The same brochure on a lead the rep can't see: pointed at by someone who sees every lead.
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE whatsapp_media SET status = 'ready', sha256 = $1 WHERE lead_id = $2", [A, L.other]),
    );
    expect(await refs()).toEqual({ a: 2, b: 0 });
    // Moving one to another file: one down, one up.
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE whatsapp_media SET sha256 = $1 WHERE lead_id = $2", [B, L.other]),
    );
    expect(await refs()).toEqual({ a: 1, b: 1 });
    // A file media still points at can't be deleted, whatever its count says.
    await expect(
      as("lume_app", { scope: null }, (c) => c.query("DELETE FROM whatsapp_files WHERE sha256 = $1", [A])),
    ).rejects.toThrow(/foreign key/);
    // A purge removes media as another role: the counts follow.
    await as("lume_owner", { scope: "all" }, (c) =>
      c.query("DELETE FROM whatsapp_media WHERE lead_id = $1", [L.rep]),
    );
    expect(await refs()).toEqual({ a: 0, b: 1 });
    // A count can't go below 0, and never blocks a delete.
    await as("lume_owner", { scope: "all" }, async (c) => {
      await c.query("UPDATE whatsapp_files SET refs = 0 WHERE sha256 = $1", [B]);
      await c.query("DELETE FROM whatsapp_media WHERE lead_id = $1", [L.other]);
    });
    expect(await refs()).toEqual({ a: 0, b: 0 });
  });

  it("the worker never sees which files exist; it only clears the off-site list of files that went", async () => {
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT sha256 FROM whatsapp_files")),
    ).rejects.toThrow(/permission/);
    await expect(
      as("lume_worker", { scope: null }, (c) =>
        c.query("INSERT INTO whatsapp_files_gone (sha256) VALUES ($1)", ["c".repeat(64)]),
      ),
    ).rejects.toThrow(/permission/);
    await as("lume_app", { scope: null }, (c) =>
      c.query("INSERT INTO whatsapp_files_gone (sha256) VALUES ($1)", ["c".repeat(64)]),
    );
    await as("lume_worker", { scope: null }, async (c) => {
      expect((await c.query("SELECT sha256 FROM whatsapp_files_gone")).rows).toEqual([
        { sha256: "c".repeat(64) },
      ]);
      await c.query("DELETE FROM whatsapp_files_gone");
    });
  });

  it("replies sent from LUME are seen with their lead, never by the worker; one key twice is one message (W3a)", async () => {
    const out = (lead: string, key: string, user: string = U.rep) =>
      `INSERT INTO whatsapp_outbox (id, lead_id, number_id, user_id, client_key, text, status)
       VALUES (gen_random_uuid(), '${lead}', '${N.rep}', '${user}', '${key}', 'Hello', 'queued')`;
    const K1 = "0190e0c0-0000-7000-8000-0000000000f1";
    const K2 = "0190e0c0-0000-7000-8000-0000000000f2";
    await as("lume_owner", { scope: "all" }, async (c) => {
      await c.query(out(L.rep, K1));
      await c.query(out(L.other, K2, U.other));
    });
    const seen = (s: Scope) =>
      as("lume_app", s, async (c) =>
        (await c.query<{ lead_id: string }>("SELECT lead_id FROM whatsapp_outbox")).rows.map(
          (r) => r.lead_id,
        ),
      );
    expect(await seen({ scope: "own", user: U.rep })).toEqual([L.rep]);
    expect(await seen({ scope: "all" })).toHaveLength(2);
    expect(await seen({ scope: null })).toEqual([]);
    await expect(as("lume_owner", { scope: "all" }, (c) => c.query(out(L.rep, K1)))).rejects.toThrow(
      /unique/,
    );
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT text FROM whatsapp_outbox")),
    ).rejects.toThrow(/permission/);
    // A file attached and not sent yet is a draft, and says who attached it.
    await as("lume_owner", { scope: "all" }, (c) =>
      c.query("UPDATE whatsapp_media SET draft = true, uploaded_by = $1 WHERE lead_id = $2", [U.rep, L.rep]),
    );
    // The Meta upload cache: per number and file.
    const F = "9".repeat(64);
    await as("lume_owner", { scope: "all" }, async (c) => {
      await c.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 1) ON CONFLICT DO NOTHING", [F]);
      await c.query(
        "INSERT INTO whatsapp_meta_uploads (number_id, sha256, meta_media_id) VALUES ($1, $2, 'M1')",
        [N.rep, F],
      );
      await expect(
        c.query(
          "INSERT INTO whatsapp_meta_uploads (number_id, sha256, meta_media_id) VALUES ($1, $2, 'M2')",
          [N.rep, F],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("a number's token is never readable by the worker, and the same message twice is one event", async () => {
    await expect(
      as("lume_worker", { scope: null }, (c) => c.query("SELECT token_enc FROM whatsapp_numbers")),
    ).rejects.toThrow(/permission/);
    await as("lume_app", { scope: "all" }, async (c) => {
      const ins = () =>
        c.query(
          "INSERT INTO whatsapp_events (phone_number_id, wamid, kind, status) VALUES ('1111111111', 'wamid.X', 'received', 'queued') ON CONFLICT DO NOTHING",
        );
      await ins();
      await ins();
      expect(
        Number((await c.query("SELECT count(*) FROM whatsapp_events WHERE wamid = 'wamid.X'")).rows[0].count),
      ).toBe(1);
    });
  });
});
