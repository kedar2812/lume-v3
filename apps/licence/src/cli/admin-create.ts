// The licence server's one admin (R4), made once on its host:
//   docker compose run --rm -it app node dist/admin-create.mjs owner@example.com
// The password is asked for (never an argument, so it stays out of shell history). The two-step secret is
// printed once, to add to an authenticator app.
import { masterKeyFromBase64 } from "@lume/core";
import pg from "pg";
import { Limiter } from "@/lib/limit";
import { createAdmin, passwordProblem } from "@/server/auth";
import { secretFrom, type Ctx } from "@/server/context";
import { askHidden } from "./prompt";

const email = process.argv[2];
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  console.error("usage: admin-create <email>");
  process.exit(2);
}
const masterKey = secretFrom(process.env, "LICENCE_MASTER_KEY");
if (!process.env.DATABASE_URL || !masterKey) {
  console.error("DATABASE_URL and LICENCE_MASTER_KEY (or LICENCE_MASTER_KEY_FILE) must be set");
  process.exit(2);
}

const password = process.env.ADMIN_PASSWORD ?? (await askHidden("Password (12+ characters, not shown): "));
const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const ctx = {
  db,
  now: () => new Date(),
  master: masterKeyFromBase64(masterKey),
  limits: { ip: new Limiter(1, 1), instance: new Limiter(1, 1), signIn: new Limiter(1, 1) },
  fetch: globalThis.fetch,
} as unknown as Ctx;
try {
  const { secret, uri } = await createAdmin(ctx, { email, password });
  console.log("");
  console.log(`Admin ${email.toLowerCase()} created.`);
  console.log("Add this to your authenticator app now (it is not shown again):");
  console.log(`  Secret: ${secret}`);
  console.log(`  Or scan: ${uri}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
