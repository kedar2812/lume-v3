import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/** Phase 6B (plan Task 1): each lead export, its code, its check row and its sealed file. */
const U = "0190e0c0-0000-7000-8000-0000000006c1";
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
const insert = (c: pg.Client, id: string, over: Record<string, unknown> = {}) => {
  const v = { code: "LX7Q-4MRA", format: "csv", email: `a.b.${id.slice(-6)}@example.invalid`, ...over };
  return c.query(
    `INSERT INTO lead_exports (id, user_id, code, label, format, filters, columns, row_count,
                               check_name, check_email, check_phone, check_position, file_enc, expires_at)
     VALUES ($1, $2, $3, 'Hot leads', $4, '{}', '{name,phone}', 12, 'Ana Bell', $5, '+447700900123', 3,
             decode('00', 'hex'), now() + interval '24 hours')`,
    [id, U, v.code, v.format, v.email],
  );
};

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await run("lume_owner", (c) =>
    c.query(
      "INSERT INTO users (id, email, name, status) VALUES ($1, 'maya@example.test', 'Maya Kapoor', 'active')",
      [U],
    ),
  );
});
afterAll(async () => db.drop());

describe("lead_exports (6B)", () => {
  it("lets the API record an export, count a download and clear its file", async () => {
    await run("lume_app", async (c) => {
      await insert(c, "0190e0c0-0000-7000-8000-0000000006d1");
      await c.query(
        "UPDATE lead_exports SET downloads = downloads + 1, last_downloaded_at = now() WHERE id = $1",
        ["0190e0c0-0000-7000-8000-0000000006d1"],
      );
      await c.query("UPDATE lead_exports SET file_enc = NULL, cleared_at = now() WHERE id = $1", [
        "0190e0c0-0000-7000-8000-0000000006d1",
      ]);
      const { rows } = await c.query("SELECT downloads, file_enc FROM lead_exports WHERE id = $1", [
        "0190e0c0-0000-7000-8000-0000000006d1",
      ]);
      expect(rows[0]).toEqual({ downloads: 1, file_enc: null });
    });
  });

  it("keeps codes and check emails unique, and only CSV or Excel", async () => {
    await run("lume_owner", async (c) => {
      await expect(insert(c, "0190e0c0-0000-7000-8000-0000000006d2")).rejects.toThrow(/unique|duplicate/i);
      await expect(
        insert(c, "0190e0c0-0000-7000-8000-0000000006d3", {
          code: "P2KD-8WZN",
          email: "a.b.0006d1@example.invalid",
        }),
      ).rejects.toThrow(/unique|duplicate/i);
      await expect(
        insert(c, "0190e0c0-0000-7000-8000-0000000006d4", { code: "H9TB-3QXE", format: "pdf" }),
      ).rejects.toThrow(/check/i);
      await expect(insert(c, "0190e0c0-0000-7000-8000-0000000006d5", { code: "lowercase" })).rejects.toThrow(
        /check/i,
      );
    });
  });
});
