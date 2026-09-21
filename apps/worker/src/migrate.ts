import { runMigrateCommand } from "@lume/db";

try {
  await runMigrateCommand();
  process.exit(0);
} catch (err) {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", error: (err as Error).message }));
  process.exit(1);
}
