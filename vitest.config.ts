import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
