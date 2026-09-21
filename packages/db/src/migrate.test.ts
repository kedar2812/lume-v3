import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationError, migrate } from "./migrate";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
let dir: string;
beforeEach(async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), "mig-"));
});
afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, sql: string) => writeFile(path.join(dir, name), sql);
async function tables(): Promise<string[]> {
  const c = new pg.Client({ connectionString: db.url() });
  await c.connect();
  const { rows } = await c.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY 1",
  );
  await c.end();
  return rows.map((r) => r.t);
}

describe("migrate", () => {
  it("applies pending migrations in order and skips them on the next run", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await put("0002_b.sql", "CREATE TABLE b (id int);");
    expect(await migrate(db.url(), dir)).toEqual({ applied: ["0001_a.sql", "0002_b.sql"], skipped: [] });
    expect(await migrate(db.url(), dir)).toEqual({ applied: [], skipped: ["0001_a.sql", "0002_b.sql"] });
    expect(await tables()).toEqual(["a", "b", "schema_migrations"]);
  });

  it("refuses a migration edited after it was applied", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await migrate(db.url(), dir);
    await put("0001_a.sql", "CREATE TABLE a (id bigint);");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/edited after it was applied/);
  });

  it("refuses when an applied migration's file is missing", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await migrate(db.url(), dir);
    await rm(path.join(dir, "0001_a.sql"));
    await put("0002_b.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(MigrationError);
  });

  it("rolls back a failing migration and does not record it", async () => {
    await put("0001_a.sql", "CREATE TABLE a (id int);");
    await put("0002_bad.sql", "CREATE TABLE b (id int); SELECT * FROM does_not_exist;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/0002_bad\.sql failed/);
    expect(await tables()).toEqual(["a", "schema_migrations"]);
  });

  it("rejects badly named or non-contiguous files", async () => {
    await put("0001_a.sql", "SELECT 1;");
    await put("0003_c.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/expected 0002/);
    await rm(path.join(dir, "0003_c.sql"));
    await put("2_Bad-Name.sql", "SELECT 1;");
    await expect(migrate(db.url(), dir)).rejects.toThrow(/NNNN_lower_snake/);
  });
});
