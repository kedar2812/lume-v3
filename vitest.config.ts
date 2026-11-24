import { defineConfig } from "vitest/config";
import { TIME_LIMITS } from "./vitest.shared";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "scripts"],
    ...TIME_LIMITS,
  },
});
