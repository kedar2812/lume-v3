import { defineConfig, devices } from "@playwright/test";

/** The licence panel end to end: the built server on a fresh database seeded with the canvas's clients. */
const PORT = 3120;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: process.env.GITHUB_ACTIONS ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command:
      "node ../../scripts/bundle.mjs . e2e/prepare.ts e2e/.artifacts/prepare.mjs && node e2e/.artifacts/prepare.mjs e2e && pnpm exec next build && node e2e/start.mjs",
    url: `http://127.0.0.1:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { E2E_LICENCE_PORT: String(PORT) },
  },
});
