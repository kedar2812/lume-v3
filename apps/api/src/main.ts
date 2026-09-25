import pg from "pg";
import { loadBreachedChecker, masterKeyFromBase64 } from "@lume/core";
import { ARGON2_PRODUCTION } from "@lume/core/password";
import { apiSchema, loadConfig } from "@lume/config";
import { buildApp } from "./app";
import { processSetupTokens } from "./auth/setup-token";
import { loadKeyring } from "./crypto/keyring-store";
import { REDACT_PATHS } from "./logger";
import { createMailer } from "./mail/mailer";
import { fixedRates, openErApi, openExchangeRates } from "./money/rates";

const cfg = loadConfig(apiSchema);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_APP, max: 10 });
const publicUrl = cfg.LUME_PUBLIC_URL ?? `https://${cfg.LUME_PUBLIC_HOST}`;
const { rows } = await pool.query<{ has_users: boolean }>("SELECT EXISTS (SELECT 1 FROM users) AS has_users");

const app = await buildApp({
  pool,
  keyring: await loadKeyring(pool, masterKeyFromBase64(cfg.LUME_MASTER_KEY)),
  mailer: createMailer(cfg.SMTP_URL, cfg.MAIL_FROM ?? `LUME <no-reply@${cfg.LUME_PUBLIC_HOST}>`),
  config: { publicUrl, cookieSecure: true, version: cfg.LUME_VERSION },
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
});
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
