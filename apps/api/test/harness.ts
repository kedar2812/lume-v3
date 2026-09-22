import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import {
  Keyring,
  QUEUE_NAMES,
  createBreachedChecker,
  masterKeyFromBase64,
  newId,
  newStoredKey,
  newTotpSecret,
  randomToken,
  sha256Hex,
  type Grant,
  type PresetKey,
} from "@lume/core";
import {
  MIGRATIONS_DIR_DEFAULT,
  createTestDatabase,
  installQueueSchema,
  migrate,
  schema as dbSchema,
  type DbRole,
} from "@lume/db";
import { hashPassword, type Argon2Params } from "@lume/core/password";
import { buildApp, type AppDeps } from "../src/app";
import type { SetupTokens } from "../src/auth/setup-token";
import type { Mailer, OutgoingMail } from "../src/mail/mailer";
import { seedConfiguration } from "../src/modules/pipelines/seed";
import { loadActor, type ActorRecord } from "../src/rbac/actor";

/** Fast Argon2 for tests only; production uses ARGON2_PRODUCTION. */
export const TEST_ARGON2: Argon2Params = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
export const TEST_PUBLIC_URL = "https://lume.test";
const SETUP_TOKEN = "test-setup-token-0000000000000000";
const PASSWORD = "correct horse battery staple";
/** Stands in as lume.user_id for fixture writes; never a real user. */
export const SYSTEM_USER = "0190e0c0-0000-7000-8000-000000000000";

/** As lume_owner in one transaction with request scope `all`: lead tables FORCE RLS even for their owner. */
async function withAllScope<T>(ownerPool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      SYSTEM_USER,
    ]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export type HarnessConfig = {
  pipelineId: string;
  stages: Record<string, string>;
  fields: Record<string, string>;
  lostReasons: string[];
};

export type SeededUser = { id: string; email: string; password: string; totpSecret?: string };
export type SeedUserOptions = {
  email?: string;
  name?: string;
  /** Put the user in a fresh role with exactly these grants. Omit for no role at all. */
  grants?: Grant[];
  owner?: boolean;
  totp?: boolean;
  status?: "invited" | "active" | "disabled";
};
export type AuthedClient = {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
};

export type Harness = {
  app: FastifyInstance;
  /** The app's own pool (lume_app), the same privileges production has. */
  pool: pg.Pool;
  /** Owner connection for arranging fixtures the app role may not write. */
  ownerPool: pg.Pool;
  keyring: Keyring;
  mail: OutgoingMail[];
  clock: { now: Date; advance(ms: number): void };
  setupToken: string;
  url(role: DbRole): string;
  /** A fresh CSRF cookie + matching header, to spread into a mutating inject(). */
  csrf(): Promise<{ headers: Record<string, string>; cookies: Record<string, string> }>;
  seedUser(o?: SeedUserOptions): Promise<SeededUser>;
  /** A full session minted directly (the login flow has its own tests). */
  signIn(user: SeededUser): Promise<AuthedClient>;
  /** Give a user an extra role with these grants and announce it on lume_rbac. */
  grant(userId: string, grants: Grant[]): Promise<void>;
  seedTeam(leadId: string, memberIds: string[]): Promise<string>;
  /** Resolves once every lume_rbac notification sent before this call has reached the app. */
  waitForRbacNotify(): Promise<void>;
  actorOf(userId: string): Promise<ActorRecord | null>;
  /** Ids of the default pipeline's live stages, every field (by key) and the lost reasons (in order). */
  config(): Promise<HarnessConfig>;
  /** Read lead tables in a test assertion: runs as lume_owner under request scope `all`. */
  queryAll<R extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<R[]>;
  /** A lead in the default pipeline, written with full scope (bypasses nothing: RLS is simply satisfied). */
  seedLead(o: {
    ownerId: string | null;
    name?: string;
    stage?: string;
    phone?: string;
    email?: string;
  }): Promise<string>;
  close(): Promise<void>;
};

export async function createHarness(
  opts: { extraRoutes?: AppDeps["extraRoutes"]; noSettings?: boolean; preset?: PresetKey } = {},
): Promise<Harness> {
  const tdb = await createTestDatabase();
  await installQueueSchema(tdb.url("lume_owner"), QUEUE_NAMES);
  await migrate(tdb.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  const pool = new pg.Pool({ connectionString: tdb.url("lume_app"), max: 8 });
  const ownerPool = new pg.Pool({ connectionString: tdb.url("lume_owner"), max: 2 });

  const master = masterKeyFromBase64(Buffer.alloc(32, 7).toString("base64"));
  const key = newStoredKey(master);
  await ownerPool.query("INSERT INTO crypto_keys (id, wrapped, active) VALUES ($1, $2, true)", [
    key.id,
    key.wrapped,
  ]);
  const keyring = Keyring.create(master, [key]);
  if (!opts.noSettings) {
    await ownerPool.query(
      "INSERT INTO settings (business_name, timezone, currency, default_country_iso, industry_preset) VALUES ('Test Co', 'Asia/Dubai', 'AED', 'AE', 'general')",
    );
    await withAllScope(ownerPool, (c) =>
      seedConfiguration(drizzle(c, { schema: dbSchema }), opts.preset ?? "general"),
    );
  }

  const mail: OutgoingMail[] = [];
  const mailer: Mailer = { send: async (m) => void mail.push(m) };
  const clock = {
    now: new Date("2026-09-21T09:00:00Z"),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  let token: string | null = SETUP_TOKEN;
  const setupTokens: SetupTokens = { current: () => token, burn: () => void (token = null) };
  const waiters = new Map<string, () => void>();

  const app = await buildApp({
    pool,
    keyring,
    mailer,
    config: { publicUrl: TEST_PUBLIC_URL, cookieSecure: true },
    clock: () => clock.now,
    setupTokens,
    isBreached: createBreachedChecker(Buffer.alloc(0)),
    argon2: TEST_ARGON2,
    onRbacEvent: (payload) => {
      waiters.get(payload)?.();
    },
    extraRoutes: opts.extraRoutes,
  });

  const addRole = async (userId: string, grants: Grant[]) => {
    const roleId = newId();
    await ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, $2)", [
      roleId,
      `role-${roleId.slice(-12)}`,
    ]);
    for (const g of grants) {
      await ownerPool.query(
        "INSERT INTO role_permissions (role_id, permission_key, scope) VALUES ($1, $2, $3)",
        [roleId, g.key, g.scope],
      );
    }
    await ownerPool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleId]);
  };

  const h: Harness = {
    app,
    pool,
    ownerPool,
    keyring,
    mail,
    clock,
    setupToken: SETUP_TOKEN,
    url: (role) => tdb.url(role),
    async csrf() {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
      const c = res.cookies.find((x) => x.name === "__Host-lume_csrf");
      if (!c) throw new Error(`no CSRF cookie (status ${res.statusCode})`);
      return {
        headers: { "x-csrf-token": c.value, origin: TEST_PUBLIC_URL },
        cookies: { "__Host-lume_csrf": c.value },
      };
    },
    async seedUser(o = {}) {
      const id = newId();
      const email = o.email ?? `u-${id.slice(-12)}@test.lume`;
      const totpSecret = o.totp ? newTotpSecret() : undefined;
      await ownerPool.query(
        `INSERT INTO users (id, email, name, password_hash, status, is_owner, totp_enabled, totp_secret_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          email,
          o.name ?? "Test User",
          await hashPassword(PASSWORD, TEST_ARGON2),
          o.status ?? "active",
          o.owner ?? false,
          Boolean(totpSecret),
          totpSecret ? keyring.encrypt(totpSecret, `totp:${id}`) : null,
        ],
      );
      if (o.grants) await addRole(id, o.grants);
      return { id, email, password: PASSWORD, totpSecret };
    },
    async signIn(user) {
      const session = randomToken();
      await ownerPool.query(
        "INSERT INTO sessions (id, user_id, stage, expires_at, created_at, last_seen_at) VALUES ($1, $2, 'full', $3, $4, $4)",
        [sha256Hex(session), user.id, new Date(clock.now.getTime() + 7 * 24 * 3600_000), clock.now],
      );
      const csrf = await h.csrf();
      const cookies = { ...csrf.cookies, "__Host-lume_session": session };
      return {
        cookies,
        headers: csrf.headers,
        inject: (req) =>
          app.inject({
            ...req,
            cookies: { ...cookies, ...(req.cookies as Record<string, string> | undefined) },
            headers: { ...csrf.headers, ...(req.headers as Record<string, string> | undefined) },
          }),
      };
    },
    async grant(userId, grants) {
      await addRole(userId, grants);
      await ownerPool.query("SELECT pg_notify('lume_rbac', $1)", [userId]);
    },
    async seedTeam(leadId, memberIds) {
      const teamId = newId();
      await ownerPool.query("INSERT INTO teams (id, name) VALUES ($1, $2)", [
        teamId,
        `team-${teamId.slice(-12)}`,
      ]);
      await ownerPool.query("INSERT INTO team_members (team_id, user_id, is_lead) VALUES ($1, $2, true)", [
        teamId,
        leadId,
      ]);
      for (const m of memberIds)
        await ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, m]);
      return teamId;
    },
    async waitForRbacNotify() {
      // Postgres delivers notifications in commit order, so once our marker arrives, everything
      // committed before it has been handled. The marker matches no user id, so it evicts nothing.
      const marker = `marker-${randomToken(8)}`;
      const arrived = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("lume_rbac marker never arrived")), 5000);
        waiters.set(marker, () => {
          clearTimeout(t);
          resolve();
        });
      });
      await ownerPool.query("SELECT pg_notify('lume_rbac', $1)", [marker]);
      await arrived;
      waiters.delete(marker);
    },
    actorOf: (userId) => loadActor(pool, userId),
    async queryAll(sql, params = []) {
      return withAllScope(ownerPool, async (c) => (await c.query(sql, params)).rows);
    },
    async config() {
      const p = (
        await ownerPool.query<{ id: string }>(
          "SELECT id FROM pipelines WHERE is_default AND archived_at IS NULL",
        )
      ).rows[0];
      if (!p) throw new Error("no default pipeline (harness created with noSettings?)");
      const stages = await ownerPool.query<{ name: string; id: string }>(
        "SELECT name, id FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL",
        [p.id],
      );
      const fields = await ownerPool.query<{ key: string; id: string }>(
        "SELECT key, id FROM field_definitions",
      );
      const reasons = await ownerPool.query<{ id: string }>(
        "SELECT id FROM lost_reasons WHERE archived_at IS NULL ORDER BY position",
      );
      return {
        pipelineId: p.id,
        stages: Object.fromEntries(stages.rows.map((r) => [r.name, r.id])),
        fields: Object.fromEntries(fields.rows.map((r) => [r.key, r.id])),
        lostReasons: reasons.rows.map((r) => r.id),
      };
    },
    async seedLead(o) {
      const cfg = await h.config();
      const stageId = cfg.stages[o.stage ?? Object.keys(cfg.stages).find((n) => n === "New") ?? ""];
      if (!stageId) throw new Error(`no stage ${o.stage ?? "New"}`);
      const id = newId();
      await withAllScope(ownerPool, (c) =>
        c.query(
          `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_e164, phone_status, email)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            cfg.pipelineId,
            stageId,
            o.ownerId,
            o.name ?? `Lead ${id.slice(-6)}`,
            o.phone ?? null,
            o.phone ? "valid" : "missing",
            o.email ?? null,
          ],
        ),
      );
      return id;
    },
    async close() {
      await app.close();
      await pool.end();
      await ownerPool.end();
      await tdb.drop();
    },
  };
  return h;
}
