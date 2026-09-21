import { randomBytes } from "node:crypto";
import pg from "pg";

export type DbRole = "lume_owner" | "lume_app" | "lume_worker" | "lume_readonly_backup" | "lume_restore";

export type TestDatabase = {
  name: string;
  /** Connection URL for this database as the given role (default lume_owner). */
  url(role?: DbRole): string;
  drop(): Promise<void>;
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
    drop: () => asAdmin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))),
  };
}
