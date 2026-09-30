// Starts the built licence server with the environment prepare.ts wrote (never real secrets).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const env = JSON.parse(readFileSync(new URL("./.artifacts/env.json", import.meta.url), "utf8"));
const port = process.env.E2E_LICENCE_PORT ?? "3120";
const child = spawn("pnpm", ["exec", "next", "start", "-p", port, "-H", "127.0.0.1"], {
  stdio: "inherit",
  env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
