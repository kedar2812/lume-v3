// Starts the real API (built bundle) against the e2e database, logging to e2e/.artifacts/api.log so the
// tests can read the first-run setup token exactly as an operator would.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const root = path.resolve(here, "../../..");
const admin = new URL(process.env.TEST_DATABASE_URL ?? "postgres://missing");
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL is required (scripts/dev.sh test-db up)");
const appPw = process.env.TEST_PW_LUME_APP;
if (!appPw) throw new Error("TEST_PW_LUME_APP is required");
const dbUrl = `postgres://lume_app:${encodeURIComponent(appPw)}@${admin.host}/lume_e2e`;

mkdirSync(path.join(here, ".artifacts"), { recursive: true });
const log = createWriteStream(path.join(here, ".artifacts/api.log"), { flags: "w" });

const child = spawn(process.execPath, [path.join(root, "apps/api/dist/main.js")], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    API_PORT: process.env.E2E_API_PORT ?? "3101",
    DATABASE_URL_APP: dbUrl,
    LUME_PUBLIC_HOST: "127.0.0.1",
    LUME_PUBLIC_URL: `http://127.0.0.1:${process.env.E2E_EDGE_PORT ?? 3100}`,
    LUME_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    SMTP_URL: `smtp://127.0.0.1:${process.env.E2E_SMTP_PORT ?? 3110}`,
    MAIL_FROM: "LUME <no-reply@lume.test>",
    BREACHED_LIST_FILE: path.join(root, "packages/core/data/breached-sha1.bin"),
    // Never the live rates site in tests: a fixed table, so a switch quotes the same rate every run.
    LUME_FX_PROVIDER: "fixed",
    LUME_FX_FIXED: "AED:USD=0.27",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
