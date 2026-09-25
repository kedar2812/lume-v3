// Copies the country flags (country-flag-icons, MIT) into apps/web/public/flags, so the phone
// country picker loads them lazily as plain images from our own origin: no JS cost, no CDN.
//   node scripts/sync-flags.mjs     (after pnpm install; commit the result)
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("apps/web/package.json"));
const pkg = path.dirname(require.resolve("country-flag-icons/package.json"));
const from = path.join(pkg, "3x2");
const to = path.resolve("apps/web/public/flags");
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((f) => /^[A-Z]{2}\.svg$/.test(f));
for (const f of files) copyFileSync(path.join(from, f), path.join(to, f));
writeFileSync(
  path.join(to, "LICENSE.txt"),
  "Flags from country-flag-icons (https://gitlab.com/catamphetamine/country-flag-icons), MIT licence.\n",
);
console.log(`copied ${files.length} flags`);
