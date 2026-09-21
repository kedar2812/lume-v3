import { sql } from "drizzle-orm";
import type { Db } from "../db/context";

/** Delivered on COMMIT only, so a rolled-back change never busts the cache. */
export async function notifyRbac(db: Db, userId?: string): Promise<void> {
  await db.execute(sql`SELECT pg_notify('lume_rbac', ${userId ?? ""})`);
}
