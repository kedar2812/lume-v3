import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.GITHUB_ACTIONS ? [["github"], ["list"]] : "list",
  // Same container everywhere, so renders are deterministic: allow only anti-aliasing noise.
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled" } },
  use: { baseURL: "http://127.0.0.1:3100", reducedMotion: "reduce", viewport: { width: 1366, height: 800 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 800 } } },
  ],
  webServer: {
    command: "pnpm build && pnpm start -p 3100 -H 127.0.0.1",
    url: "http://127.0.0.1:3100/sign-in",
    timeout: 240_000,
    reuseExistingServer: false,
    env: { LUME_DESIGN_SHOWCASE: "1", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
