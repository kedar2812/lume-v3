import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TIME_LIMITS } from "../../vitest.shared";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "@lume/web",
    ...TIME_LIMITS,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "e2e/site/**/*.test.ts"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
