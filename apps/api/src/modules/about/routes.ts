import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../../app";
import pkg from "../../../package.json" with { type: "json" };

/** Settings → About: the version running, and how the last weekly restore test went (report §12.7). */
export async function aboutRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  app.get("/api/v1/about", { config: { permission: "auth.self" } }, async (req) => {
    const rows = await req.db.execute<{ finished_at: Date; ok: boolean; backup_name: string | null }>(
      sql`SELECT finished_at, ok, backup_name FROM ops_restore_tests ORDER BY finished_at DESC LIMIT 1`,
    );
    const last = rows.rows[0];
    return {
      version: d.config.version ?? pkg.version,
      lastRestoreTest: last
        ? { finishedAt: new Date(last.finished_at).toISOString(), ok: last.ok, backup: last.backup_name }
        : null,
    };
  });
}
