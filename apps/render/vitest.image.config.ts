import { defineConfig } from "vitest/config";

// The real tools' tests, run only in the image that has them (infra/docker/render.Dockerfile, stage "test").
export default defineConfig({
  test: {
    include: ["test/**/*.itest.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
