// LUME AI's eval runner (plan 2026-10-18 Task 11): bundles scripts/ai-eval/run.ts — the API's own provider adapters
// and LUME's cleaner, in TypeScript — and runs it. A real provider spends money: it refuses to run without --yes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "lume-ai-eval-"));
const outfile = path.join(dir, "run.mjs");
try {
  await build({
    entryPoints: [path.join(here, "ai-eval", "run.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: "import { createRequire as __lumeRequire } from 'node:module'; const require = __lumeRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  const { run } = await import(pathToFileURL(outfile).href);
  process.exitCode = await run(process.argv.slice(2), path.resolve(here, ".."));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
