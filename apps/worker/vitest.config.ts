import { defineConfig } from "vitest/config";
import { TIME_LIMITS } from "../../vitest.shared";

export default defineConfig({ test: { name: "@lume/worker", ...TIME_LIMITS } });
