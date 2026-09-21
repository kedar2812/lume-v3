import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import * as schema from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
let columns: Map<string, Map<string, { nullable: boolean }>>;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  const c = new pg.Client({ connectionString: db.url("lume_owner") });
  await c.connect();
  const { rows } = await c.query<{ t: string; c: string; n: string }>(
    "SELECT table_name AS t, column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = 'public'",
  );
  await c.end();
  columns = new Map();
  for (const r of rows) {
    if (!columns.has(r.t)) columns.set(r.t, new Map());
    columns.get(r.t)!.set(r.c, { nullable: r.n === "YES" });
  }
});
afterAll(async () => db.drop());

const tables = Object.values(schema).filter(
  (v): v is PgTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v,
);

describe("Drizzle mirror matches the migrations", () => {
  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))("%s", (name, table) => {
    const live = columns.get(name);
    expect(live, `table ${name} missing in the database`).toBeDefined();
    const cfg = getTableConfig(table);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([...live!.keys()].sort());
    for (const col of cfg.columns)
      expect(`${name}.${col.name} nullable=${!col.notNull}`).toBe(
        `${name}.${col.name} nullable=${live!.get(col.name)!.nullable}`,
      );
  });
});
