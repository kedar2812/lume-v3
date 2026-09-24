import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  // The shared rule engine and step lists ship as TypeScript from the workspace.
  transpilePackages: ["@lume/core"],
};
export default config;
