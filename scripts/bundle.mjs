// Bundle an app entrypoint (and its workspace packages + npm deps) into one ESM file, so runtime images need no node_modules.
import path from "node:path";
import { build } from "esbuild";

const [appDir, ...pairs] = process.argv.slice(2);
if (!appDir || pairs.length === 0 || pairs.length % 2 !== 0) {
  console.error("usage: bundle.mjs <appDir> <entry> <outfile> [<entry> <outfile> …]");
  process.exit(2);
}
const banner = [
  "import { createRequire as __lumeRequire } from 'node:module';",
  "import { fileURLToPath as __lumeFile } from 'node:url';",
  "import { dirname as __lumeDir } from 'node:path';",
  "const require = __lumeRequire(import.meta.url);",
  "const __filename = __lumeFile(import.meta.url);",
  "const __dirname = __lumeDir(__filename);",
].join("\n");

for (let i = 0; i < pairs.length; i += 2) {
  await build({
    entryPoints: [path.join(appDir, pairs[i])],
    outfile: path.join(appDir, pairs[i + 1]),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    legalComments: "none",
    // Native modules cannot be inlined; images that need one install it next to dist/.
    external: ["pg-native", "@node-rs/argon2"],
    banner: { js: banner },
    logLevel: "warning",
  });
}
