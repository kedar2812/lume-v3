import { randomBytes } from "node:crypto";
import pg from "pg";

export type DbRole = "lume_owner" | "lume_app" | "lume_worker" | "lume_readonly_backup" | "lume_restore";

export type TestDatabase = {
  name: string;
  /** Connection URL for this database as the given role (default lume_owner). */
  url(role?: DbRole): string;
  /** Drop the database. `immediate` kills live connections at once (for tests that simulate an outage). */
  drop(opts?: { immediate?: boolean }): Promise<void>;
};

export function adminUrl(): string {
  const u = process.env.TEST_DATABASE_URL;
  if (!u) throw new Error("TEST_DATABASE_URL is not set. Run `scripts/dev.sh test-db up` first.");
  return u;
}

export function roleUrl(role: DbRole, database: string): string {
  const u = new URL(adminUrl());
  const pw = process.env[`TEST_PW_${role.toUpperCase()}`];
  if (!pw) throw new Error(`TEST_PW_${role.toUpperCase()} is not set`);
  u.username = role;
  u.password = pw;
  u.pathname = `/${database}`;
  return u.toString();
}

async function asAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A fresh database owned by lume_owner, set up like the production one (see 00-roles.sh). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  await asAdmin(async (c) => {
    await c.query(`CREATE DATABASE ${name} OWNER lume_owner`);
    await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${name} TO lume_app, lume_worker, lume_readonly_backup`);
  });
  return {
    name,
    url: (role: DbRole = "lume_owner") => roleUrl(role, name),
    drop: (opts) =>
      asAdmin(async (c) => {
        // Give lingering connections (pools still closing) a moment to leave on their own; FORCE
        // then only ever kills a truly stuck one, instead of failing an in-flight query mid-test.
        for (let i = 0; !opts?.immediate && i < 50; i++) {
          const { rows } = await c.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [name],
          );
          if (rows[0]!.n === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
  };
}
