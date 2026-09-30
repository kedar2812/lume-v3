// Brings the licence server's database up to date (bundled to dist/migrate.mjs; run before the server).
import path from "node:path";
import { migrate } from "@lume/db";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const dir = process.env.LICENCE_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "../migrations");
const r = await migrate(url, dir);
console.log(`licence migrations: ${r.applied.length} applied, ${r.skipped.length} already there`);
