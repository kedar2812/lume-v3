import pg from "pg";
import { loadBreachedChecker, masterKeyFromBase64 } from "@lume/core";
import { ARGON2_PRODUCTION } from "@lume/core/password";
import { apiSchema, loadConfig } from "@lume/config";
import { buildApp, type AppDeps } from "./app";
import { startImportQueue } from "./modules/imports/queue";
import { createGoogleSheets, oauthClientFor, parseServiceAccount } from "./modules/sheets/google";
import { startSheetsQueue } from "./modules/sheets/queue";
import { startWebhookQueue } from "./modules/webhooks/queue";
import { startTaskQueue } from "./modules/tasks/queue";
import { processSetupTokens } from "./auth/setup-token";
import { loadKeyring } from "./crypto/keyring-store";
import { REDACT_PATHS } from "./logger";
import { createMailer } from "./mail/mailer";
import { fixedRates, openErApi, openExchangeRates } from "./money/rates";
import { appVersion, isReleaseBuild, resolveLicence } from "./licence/options";

const cfg = loadConfig(apiSchema);
// A request never waits long for a connection: exhaustion fails loudly instead of hanging the API.
const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL_APP,
  max: 10,
  connectionTimeoutMillis: 10_000,
});
// Imports (the job, and a preview's lookup beside its request) and the sheet sync get their own connections.
const jobPool = new pg.Pool({
  connectionString: cfg.DATABASE_URL_APP,
  max: 5,
  connectionTimeoutMillis: 30_000,
});
const publicUrl = cfg.LUME_PUBLIC_URL ?? `https://${cfg.LUME_PUBLIC_HOST}`;
const { rows } = await pool.query<{ has_users: boolean }>("SELECT EXISTS (SELECT 1 FROM users) AS has_users");

const keyring = await loadKeyring(pool, masterKeyFromBase64(cfg.LUME_MASTER_KEY));
// Filled in once the queue is up (it needs the built app); the queue starts before the API listens.
const imports: { enqueue(id: string): Promise<void> } = { enqueue: async () => undefined };
// Google Sheets (2B): only on a server with a service-account key; without one the module can't be switched on.
const account = parseServiceAccount(cfg.GOOGLE_SERVICE_ACCOUNT_JSON);
const google = account ? createGoogleSheets({ account, endpoint: cfg.LUME_GOOGLE_ENDPOINT }) : null;
const googleOAuth = cfg.GOOGLE_OAUTH_RELAY_URL
  ? { relayUrl: cfg.GOOGLE_OAUTH_RELAY_URL.replace(/\/$/, ""), relayToken: cfg.GOOGLE_OAUTH_RELAY_TOKEN! }
  : null;
const sheets: { enqueue(id: string): Promise<void>; maxRows: number } = {
  enqueue: async () => undefined,
  maxRows: cfg.LUME_SHEETS_MAX_ROWS,
};

// Webhooks (2C): the queue always runs; the module switch gates receiving, not processing what was accepted.
const webhooks: { enqueue(id: number): Promise<void> } = { enqueue: async () => undefined };
// Follow-ups (Phase 3): filled once the queue is up; its sweeper fires anything missed before the API listens.
const tasks: NonNullable<AppDeps["tasks"]> = {
  enqueue: async () => undefined,
};

const mailer = createMailer(cfg.SMTP_URL, cfg.MAIL_FROM ?? `LUME <no-reply@${cfg.LUME_PUBLIC_HOST}>`);

const app = await buildApp({
  pool,
  keyring,
  imports,
  jobPool,
  google,
  sheets,
  webhooks,
  tasks,
  manychatPreset: cfg.LUME_MANYCHAT_PRESET === "on",
  googleOAuth,
  ...(cfg.LUME_GOOGLE_ENDPOINT ? { googleEndpoint: cfg.LUME_GOOGLE_ENDPOINT } : {}),
  mailer,
  config: { publicUrl, cookieSecure: true, version: appVersion(cfg) },
  rates:
    cfg.LUME_FX_PROVIDER === "fixed"
      ? fixedRates(cfg.LUME_FX_FIXED ?? "")
      : cfg.LUME_FX_PROVIDER === "openexchangerates" && cfg.LUME_FX_KEY
        ? openExchangeRates(cfg.LUME_FX_KEY)
        : openErApi(),
  clock: () => new Date(),
  // Printed to stdout (not the redacting logger) so the owner can copy it from `docker compose logs api`.
  setupTokens: processSetupTokens(!rows[0]!.has_users, (m) => console.log(m)),
  isBreached: await loadBreachedChecker(cfg.BREACHED_LIST_FILE),
  argon2: ARGON2_PRODUCTION,
  logger: { level: cfg.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
  // The licence (L-A): a release image checks and enforces; a development build is always active.
  licence: resolveLicence({
    env: process.env,
    release: isReleaseBuild(),
    version: appVersion(cfg),
  }),
});
const queue = await startImportQueue({ connectionString: cfg.DATABASE_URL_APP, app, pool: jobPool, keyring });
imports.enqueue = queue.enqueue;
// Sheets sync when either way of reading them is set up here: a service account, or Connect with Google.
const sheetQueue =
  google || googleOAuth
    ? await startSheetsQueue({
        connectionString: cfg.DATABASE_URL_APP,
        app,
        pool: jobPool,
        keyring,
        google,
        clientFor: oauthClientFor(googleOAuth, cfg.LUME_GOOGLE_ENDPOINT),
        maxRows: cfg.LUME_SHEETS_MAX_ROWS,
      })
    : null;
if (sheetQueue) sheets.enqueue = sheetQueue.enqueue;
const webhookQueue = await startWebhookQueue({
  connectionString: cfg.DATABASE_URL_APP,
  app,
  pool: jobPool,
  keyring,
});
webhooks.enqueue = webhookQueue.enqueue;
const taskQueue = await startTaskQueue({
  connectionString: cfg.DATABASE_URL_APP,
  app,
  pool: jobPool,
  digest: { mailer, publicUrl },
  tickMs: cfg.LUME_FOLLOW_UP_TICK_MS,
});
tasks.enqueue = taskQueue.enqueue;
tasks.lastSweepAt = taskQueue.lastSweepAt;
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
// At start and every 6 hours (licensing L-A); the state is enforced from the database meanwhile.
app.licence.start();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await taskQueue.stop();
    await webhookQueue.stop();
    await sheetQueue?.stop();
    await queue.stop();
    await app.close();
    await jobPool.end();
    await pool.end();
    process.exit(0);
  });
}
