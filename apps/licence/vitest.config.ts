import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TIME_LIMITS } from "../../vitest.shared";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "@lume/licence",
    ...TIME_LIMITS,
    // Server modules run in node; component tests say `// @vitest-environment jsdom` at their top.
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
