import { defineConfig } from "vitest/config";

/** The release and fleet scripts (licensing L-C), run as bash with stub ssh, docker and curl. */
export default defineConfig({
  test: {
    name: "@lume/scripts",
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
