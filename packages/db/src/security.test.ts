import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/** Phase 6A (plan Task 1): the suspended status, the alerts table and the index the rules count through. */
const U = "0190e0c0-0000-7000-8000-0000000006a1";
const A = "0190e0c0-0000-7000-8000-0000000006b1";

let db: TestDatabase;
async function run<T>(role: DbRole, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await run("lume_owner", (c) =>
    c.query(
      "INSERT INTO users (id, email, name, status) VALUES ($1, 'rory@example.test', 'Rory Reid', 'active')",
      [U],
    ),
  );
});
afterAll(async () => db.drop());

const alert = (c: pg.Client, over: Record<string, unknown> = {}) => {
  const v = {
    id: A,
    rule: "reveals",
    action: "suspended",
    status: "open",
    resolution: null,
    ...over,
  };
  return c.query(
    `INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action, status, resolution)
     VALUES ($1, $2, $3, 31, 30, now() - interval '52 minutes', now(), $4, $5, $6)`,
    [v.id, U, v.rule, v.action, v.status, v.resolution],
  );
};

describe("a paused person (6A)", () => {
  it("takes the suspended status, and a watch-from time", async () => {
    await run("lume_app", async (c) => {
      await c.query("UPDATE users SET status = 'suspended', watch_from = now() WHERE id = $1", [U]);
      const { rows } = await c.query("SELECT status FROM users WHERE id = $1", [U]);
      expect(rows[0].status).toBe("suspended");
      await expect(c.query("UPDATE users SET status = 'frozen' WHERE id = $1", [U])).rejects.toThrow(
        /check/i,
      );
      await c.query("UPDATE users SET status = 'active' WHERE id = $1", [U]);
    });
  });
});

describe("security_alerts (6A)", () => {
  it("lets the API record, read and resolve an alert", async () => {
    await run("lume_app", async (c) => {
      await alert(c);
      await c.query(
        "UPDATE security_alerts SET status = 'resolved', resolution = 'restored', resolved_at = now() WHERE id = $1",
        [A],
      );
      const { rows } = await c.query("SELECT status, resolution FROM security_alerts WHERE id = $1", [A]);
      expect(rows[0]).toEqual({ status: "resolved", resolution: "restored" });
      await c.query("DELETE FROM security_alerts WHERE id = $1", [A]).catch(() => undefined);
    });
  });

  it("refuses a rule, action or resolution it doesn't know", async () => {
    await run("lume_owner", async (c) => {
      await c.query("DELETE FROM security_alerts");
      await expect(alert(c, { rule: "countries" })).rejects.toThrow(/check/i);
      await expect(alert(c, { action: "deleted" })).rejects.toThrow(/check/i);
      await expect(alert(c, { status: "resolved", resolution: "forgiven" })).rejects.toThrow(/check/i);
    });
  });

  it("keeps an open alert unresolved and a resolved one with its resolution", async () => {
    await run("lume_owner", async (c) => {
      await expect(alert(c, { status: "open", resolution: "restored" })).rejects.toThrow(/check/i);
      await expect(alert(c, { status: "resolved", resolution: null })).rejects.toThrow(/check/i);
    });
  });

  it("counts through a partial audit index on the three watched acts", async () => {
    const { rows } = await run("lume_owner", (c) =>
      c.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_log_watch'"),
    );
    expect(rows[0]?.indexdef).toMatch(/actor_user_id, action, at DESC/);
    expect(rows[0]?.indexdef).toMatch(/lead\.contact\.reveal/);
  });
});
