import { defineConfig } from "vitest/config";
import { TIME_LIMITS } from "../vitest.shared";

/** The release and fleet scripts (licensing L-C), run as bash with stub ssh, docker and curl. */
export default defineConfig({
  test: {
    name: "@lume/scripts",
    ...TIME_LIMITS,
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
