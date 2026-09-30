import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { createTestDatabase, migrate } from "@lume/db";
import pg from "pg";
import { hashKey, lastFour, newInstanceId, newLicenceKey } from "@/lib/keys";
import { Limiter } from "@/lib/limit";
import type { Ctx } from "./context";

export const LICENCE_MIGRATIONS = path.resolve(import.meta.dirname, "../../migrations");

export type LicenceTestDb = { pool: pg.Pool; url: string; close: () => Promise<void> };

/** A fresh, migrated licence database for one test file. */
export async function licenceDb(): Promise<LicenceTestDb> {
  const db = await createTestDatabase();
  await migrate(db.url(), LICENCE_MIGRATIONS);
  const pool = new pg.Pool({ connectionString: db.url(), max: 4 });
  return {
    pool,
    url: db.url(),
    close: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

let seq = 0;
/** A client and its licence, straight into the tables (the admin API's own create is tested on its own). */
export async function seedClient(
  db: pg.Pool,
  o: {
    type: "subscription" | "perpetual" | "trial";
    paidUntil?: string | null;
    trialEnds?: string | null;
    suspended?: boolean;
    decommissioned?: boolean;
    name?: string;
    country?: string;
  },
): Promise<{ clientId: string; instanceId: string; licenseKey: string }> {
  const licenseKey = newLicenceKey();
  const instanceId = newInstanceId();
  seq++;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO clients (name, slug, country, source, decommissioned_at)
     VALUES ($1, $2, $3, 'referrals', CASE WHEN $4::boolean THEN now() END) RETURNING id`,
    [
      o.name ?? `Client ${seq}`,
      `client-${seq}-${instanceId.slice(-4).toLowerCase()}`,
      o.country ?? "IN",
      !!o.decommissioned,
    ],
  );
  const clientId = rows[0]!.id;
  await db.query(
    `INSERT INTO licences (client_id, instance_id, key_hash, key_last4, type, paid_until, trial_ends, suspended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN now() END)`,
    [
      clientId,
      instanceId,
      hashKey(licenseKey),
      lastFour(licenseKey),
      o.type,
      o.paidUntil ?? null,
      o.trialEnds ?? null,
      !!o.suspended,
    ],
  );
  return { clientId, instanceId, licenseKey };
}

const HOUR = 3_600_000;
/** A signing pair made once per test file; its public half is `TEST_KEYS`' "t1". */
export const TEST_PAIR = generateKeyPairSync("ed25519");

/** A context over a test database, with its own clock and the server's real limits. */
export function testCtx(pool: pg.Pool, now: () => Date, over: Partial<Ctx> = {}): Ctx {
  return {
    db: pool,
    signer: { kid: "t1", privateKey: TEST_PAIR.privateKey },
    now,
    limits: {
      ip: new Limiter(300, HOUR),
      instance: new Limiter(60, HOUR),
      signIn: new Limiter(10, 15 * 60_000),
    },
    master: randomBytes(32),
    fetch: () => Promise.reject(new Error("no network in tests")),
    ...over,
  };
}
