import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export class MigrationError extends Error {
  override name = "MigrationError";
}

export type Migration = { name: string; sql: string; checksum: string };
export type MigrationResult = { applied: string[]; skipped: string[] };

export const MIGRATIONS_DIR_DEFAULT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 727_272; // one migrator at a time

export async function listMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => {
    const m = FILE_RE.exec(f);
    if (!m) throw new MigrationError(`${f}: migration files must be named NNNN_lower_snake.sql`);
    const expected = String(i + 1).padStart(4, "0");
    if (m[1] !== expected)
      throw new MigrationError(`${f}: expected ${expected}_*.sql next (no gaps, no duplicates)`);
  });
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/** Apply pending migrations, each in its own transaction. Forward-only; edited or missing files are refused. */
export async function migrate(connectionString: string, dir: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    const all = await listMigrations(dir);
    for (const name of done.keys()) {
      if (!all.some((m) => m.name === name))
        throw new MigrationError(`${name} was applied but its file is missing`);
    }
    const result: MigrationResult = { applied: [], skipped: [] };
    for (const m of all) {
      const prev = done.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new MigrationError(
            `${m.name} was edited after it was applied (checksum mismatch). Write a new migration instead.`,
          );
        }
        result.skipped.push(m.name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          m.name,
          m.checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(m.name);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new MigrationError(`${m.name} failed: ${(e as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
