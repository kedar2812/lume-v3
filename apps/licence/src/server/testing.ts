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
      wrongKey: new Limiter(10, HOUR),
      signIn: new Limiter(10, 15 * 60_000),
    },
    master: randomBytes(32),
    fetch: () => Promise.reject(new Error("no network in tests")),
    ...over,
  };
}

/** A browser for the admin API: keeps its cookies, and sends the CSRF token back on writes as the panel does. */
export class Jar {
  private cookies = new Map<string, string>();
  constructor(
    private readonly ctx: () => Ctx,
    private readonly ip = "203.0.113.5",
  ) {}

  get csrf(): string | undefined {
    return this.cookies.get("lume_licence_csrf");
  }
  /** Take on a session made straight in the database (see adminSession). */
  adopt(session: string, csrf: string): void {
    this.cookies.set("lume_licence", session);
    this.cookies.set("lume_licence_csrf", csrf);
  }
  snapshot(): Map<string, string> {
    return new Map(this.cookies);
  }
  restore(m: Map<string, string>): void {
    this.cookies = new Map(m);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads whatever the API answered
  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    o: { csrf?: false | string; origin?: string } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      "x-real-ip": this.ip,
      origin: o.origin ?? "https://licence.test",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const token = o.csrf === undefined ? this.csrf : o.csrf;
    if (method !== "GET" && token) headers["x-csrf-token"] = token;
    const { handleApi } = await import("./api");
    const r = await handleApi(
      new Request(`https://licence.test${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      this.ctx(),
    );
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      if (/max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1));
    }
    const text = await r.text();
    return { status: r.status, data: (text ? JSON.parse(text) : null) as T, headers: r.headers };
  }
}

/**
 * A signed-in admin for tests that move the clock by days: a session made straight in the database that
 * never idles out (sign-in itself is tested in auth.test.ts).
 */
export async function adminSession(ctx: Ctx): Promise<Jar> {
  const { createHash } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const admin = (await ctx.db.query<{ id: string }>("SELECT id FROM admins LIMIT 1")).rows[0]!;
  await ctx.db.query(
    "INSERT INTO admin_sessions (id, admin_id, csrf, last_seen_at, expires_at) VALUES ($1, $2, $3, '2100-01-01', '2100-01-01')",
    [createHash("sha256").update(token).digest(), admin.id, csrf],
  );
  const j = new Jar(() => ctx);
  j.adopt(token, csrf);
  return j;
}
