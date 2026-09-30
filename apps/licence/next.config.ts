import path from "node:path";
import type { NextConfig } from "next";

/** license.lumecrm.in (licensing L-B): its own image, never part of a client's LUME. */
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@lume/core"],
  serverExternalPackages: ["@node-rs/argon2", "pg"],
};
export default config;
