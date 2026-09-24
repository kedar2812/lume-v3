import { defineConfig, devices } from "@playwright/test";
import { stateFile } from "./e2e/fixtures";

/**
 * End to end against the real stack (spec §8): the built API on a fresh database, the built web app,
 * an SMTP sink, and an edge proxy that gives the browser one origin exactly as Caddy does.
 */
const EDGE = 3100;
const base = { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 800 } };

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0, // a flaky end-to-end test is a bug to find, not something to retry past
  timeout: 45_000,
  reporter: process.env.GITHUB_ACTIONS ? [["github"], ["list"]] : "list",
  // Same container everywhere, so renders are deterministic: allow only anti-aliasing noise.
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled" } },
  use: {
    baseURL: `http://127.0.0.1:${EDGE}`,
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...base,
  },
  projects: [
    // The wizard needs an installation with no users, so it runs first and leaves the owner signed in.
    { name: "setup-wizard", testMatch: /setup\.spec\.ts/ },
    // Then the other people every spec needs, invited by email exactly as in real use.
    {
      name: "seed",
      testMatch: /seed\.setup\.ts/,
      dependencies: ["setup-wizard"],
      use: { storageState: stateFile("owner") },
    },
    {
      name: "app",
      testIgnore: [/setup\.spec\.ts/, /seed\.setup\.ts/],
      dependencies: ["seed"],
      use: { storageState: stateFile("owner") },
    },
  ],
  webServer: [
    {
      command: "node e2e/smtp-sink.mjs",
      url: "http://127.0.0.1:3111/messages",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The database is reset before the API boots: at boot the API sees no users and prints the token.
      command:
        "pnpm --filter @lume/api build && node ../../scripts/bundle.mjs . e2e/reset-db.ts e2e/.artifacts/reset-db.mjs && node e2e/.artifacts/reset-db.mjs ../.. && node e2e/api-server.mjs",
      url: "http://127.0.0.1:3101/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
      env: { E2E_API_PORT: "3101", E2E_EDGE_PORT: String(EDGE) },
    },
    {
      command: "pnpm build && pnpm start -p 3102 -H 127.0.0.1",
      url: "http://127.0.0.1:3102/sign-in",
      reuseExistingServer: false,
      timeout: 300_000,
      env: { LUME_API_URL: "http://127.0.0.1:3101", NEXT_TELEMETRY_DISABLED: "1", LUME_DESIGN_SHOWCASE: "1" },
    },
    {
      command: "node e2e/edge.mjs",
      url: `http://127.0.0.1:${EDGE}/sign-in`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
